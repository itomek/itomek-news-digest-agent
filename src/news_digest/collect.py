"""Credential-free source collection: python -m news_digest.collect --help."""
import argparse
import hashlib
import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4
from urllib.parse import urlsplit
from urllib.robotparser import RobotFileParser

from news_digest.collector import Fetcher, USER_AGENT, canonical_url, parse_article, parse_feed, parse_html, parse_pdf

HN='https://hacker-news.firebaseio.com/v0/'


def bounded(value,default,maximum):
    if value is None: return default
    if isinstance(value,bool) or not isinstance(value,int) or not 0<value<=maximum:
        raise ValueError(f'Limit must be an integer from 1 to {maximum}')
    return value


def collect(config,fetcher,now=None,since_hours=24):
    if not isinstance(config,dict): raise ValueError("Config must be a JSON object")
    if config.get("schema_version",1)!=1: raise ValueError("Unsupported config schema_version")
    now=now or datetime.now(UTC)
    since_hours=bounded(since_hours,24,8760)
    sources=config.get('sources')
    if not isinstance(sources,list) or not 1<=len(sources)<=30: raise ValueError('Expected 1–30 sources')
    max_articles=bounded(config.get('max_articles'),50,200)
    result={'schema_version':1,'run_id':str(uuid4()),'generated_at':now.isoformat(),'since_hours':since_hours,'articles':[],'sources':[]}
    seen={}
    ids=set()
    for source in sources:
        if not isinstance(source,dict) or not isinstance(source.get('id'),str) or not source['id'] or source['id'] in ids:
            raise ValueError('Each source needs a unique nonempty string id')
        ids.add(source['id'])
    for source in sources:
        sid=source['id']; kind=source.get('type'); url=source.get('url','')
        state={'id':sid,'type':kind,'url':url,'status':'ok','articles_seen':0,'articles_added':0,'errors':[]}
        result['sources'].append(state)
        if len(result['articles'])>=max_articles:
            state['status']='skipped'; state['reason']='article_budget'; continue
        try:
            limit=bounded(source.get('limit'),10,50)
            if kind=='reddit':
                state['status']='unavailable'; state['reason']='Reddit authenticated adapter is not configured in this first slice'; continue
            if kind=='hn':
                records=[]
                inspected=0
                listing=json.loads(fetcher.get(HN+'topstories.json'))
                if not isinstance(listing,list): raise ValueError('Invalid HN listing')
                for item_id in listing[:limit]:
                    if not isinstance(item_id,int) or item_id<1: continue
                    try:
                        item=json.loads(fetcher.get(HN+f'item/{item_id}.json'))
                        inspected+=1
                        if not item or item.get('type')!='story' or item.get('deleted') or item.get('dead'): continue
                        date=datetime.fromtimestamp(item['time'],UTC)
                        if date<now-timedelta(hours=since_hours) or date>now+timedelta(minutes=5): continue
                        records.append({'title':item.get('title',''),'url':item.get('url') or f'https://news.ycombinator.com/item?id={item_id}','published_at':date.isoformat(),'text':item.get('text',''),'extraction':'hn_metadata','date_status':'known','evidence':'community_signal','signals':{'score':item.get('score',0),'comments':item.get('descendants',0),'observed_at':now.isoformat(),'discussion_url':f'https://news.ycombinator.com/item?id={item_id}'}})
                    except Exception as exc: state['errors'].append(f'HN item {item_id}: {type(exc).__name__}')
            elif kind=='rss': records=parse_feed(fetcher.get(url),url,now,since_hours)[:limit]
            elif kind in ('html','article','pdf'):
                raw=fetcher.get(url)
                parser={'html':parse_html,'article':parse_article,'pdf':parse_pdf}[kind]
                records=[parser(raw,url)]
                # Opt-in one-hop, same-origin discovery; never an unbounded spider.
                follow=source.get('follow_links',0)
                if follow:
                    follow=bounded(follow,1,10)
                    if kind!='html': raise ValueError('follow_links is only valid for html sources')
                    origin=urlsplit(url)
                    robots_url=f'{origin.scheme}://{origin.netloc}/robots.txt'
                    robots=RobotFileParser(robots_url)
                    try:
                        robots.parse(fetcher.get(robots_url).decode('utf-8',errors='replace').splitlines())
                    except Exception as exc:
                        state['errors'].append(f'robots unavailable, discovery skipped: {type(exc).__name__}')
                        follow=0
                    candidates=[x for x in records[0]['links'] if (urlsplit(x).scheme,urlsplit(x).netloc)==(origin.scheme,origin.netloc) and canonical_url(x)!=canonical_url(url)]
                    for link in candidates[:follow]:
                        if not robots.can_fetch(USER_AGENT,link):
                            state['errors'].append('robots_disallowed'); continue
                        try: records.append(parse_article(fetcher.get(link),link))
                        except Exception as exc: state['errors'].append(f'discovered article: {type(exc).__name__}')
            else: raise ValueError('Supported source types: rss, html, article, pdf, hn, reddit')
            state['articles_seen']=len(records)
            for article in records[:limit]:
                if urlsplit(article['url']).scheme not in ('http','https'): continue
                key=canonical_url(article['url'])
                provenance={'source_id':sid,'source_url':url or HN+'topstories.json','fetched_at':now.isoformat(),'topic':source.get('topic')}
                if key in seen:
                    seen[key]['provenance'].append(provenance)
                    if article.get('signals'): seen[key].setdefault('community_signals',[]).append(article['signals'])
                    continue
                if len(result['articles'])>=max_articles: break
                article['text']=article.get('text','')[:20_000]
                article['canonical_url']=key
                article['id']=hashlib.sha256(key.encode()).hexdigest()
                article['provenance']=[provenance]
                article.setdefault('evidence','source_content_unverified')
                article.pop('links',None)
                result['articles'].append(article); seen[key]=article
                state['articles_added']+=1
            if kind=='hn' and state['errors'] and inspected==0: state['status']='error'
            elif state['errors']: state['status']='partial'
            elif not records: state['status']='empty'
        except Exception as exc:
            state['status']='error'; state['errors'].append(f'{type(exc).__name__}: {exc}')
    return result


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',required=True,type=Path)
    parser.add_argument('--since-hours',type=int,default=24)
    parser.add_argument('--output',type=Path)
    parser.add_argument('--fixed-public-sources',action='store_true',help='Proxy-side DNS for only HTTPS HN API/Lemonade; redirects forbidden')
    args=parser.parse_args(argv)
    try:
        if args.config.stat().st_size>100_000: raise ValueError('Config exceeds 100 KB')
        config=json.loads(args.config.read_text())
        with Fetcher(fixed_public_sources=args.fixed_public_sources) as fetcher: result=collect(config,fetcher,since_hours=args.since_hours)
        payload=json.dumps(result,indent=2,ensure_ascii=False)+'\n'
        if args.output: args.output.write_text(payload)
        else: print(payload,end='')
        print(f"Collected {len(result['articles'])} articles from {len(result['sources'])} sources",file=sys.stderr)
        return 0 if any(s['status'] in ('ok','empty','partial') for s in result['sources']) else 1
    except (OSError,ValueError,TypeError,ImportError) as exc:
        print(f'Collector error: {exc}',file=sys.stderr); return 2

if __name__=='__main__': raise SystemExit(main())
