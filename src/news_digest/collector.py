"""Portable, bounded scraping primitives derived from tools/scraping.py.

No agent, database, environment file or model imports. HTTPX is the only required
third-party dependency. Optional article/PDF extractors are loaded on demand.
"""
import ipaddress
import json
import socket
import time
import xml.etree.ElementTree as ET
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

USER_AGENT = 'news-digest-agent/0.2 (+https://github.com/itomek/itomek-news-digest-agent)'


class UnsafeURL(ValueError):
    pass


def validate_url(url):
    parsed = urlsplit(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise UnsafeURL('Expected public HTTP(S) URL without credentials')
    try:
        addresses = [ipaddress.ip_address(parsed.hostname)]
    except ValueError:
        addresses = [ipaddress.ip_address(x[4][0]) for x in socket.getaddrinfo(parsed.hostname, parsed.port or 443)]
    if not addresses or any(not ip.is_global or ip.is_multicast for ip in addresses):
        raise UnsafeURL('Non-public destination blocked')


def canonical_url(url):
    p = urlsplit(url)
    return urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path or '/', p.query, ''))


class Fetcher:
    """Bounded HTTP transport; validate each redirect, never bypass a denial.

    DNS prevalidation is defense in depth, not a pinned-DNS security boundary.
    Run with outbound network restrictions; do not expose as a public URL proxy.
    """
    def __init__(self, transport=None, delay=1.5, max_bytes=2_000_000, max_requests=100, max_seconds=180, fixed_public_sources=False):
        self.client = httpx.Client(transport=transport, timeout=httpx.Timeout(15,connect=3), follow_redirects=False, headers={'User-Agent':USER_AGENT})
        self.fixed_public_sources = fixed_public_sources
        self.delay, self.max_bytes = delay, max_bytes
        self.max_requests, self.deadline = max_requests, time.monotonic()+max_seconds
        self.requests, self.last = 0, {}

    def __enter__(self): return self
    def __exit__(self,*args): self.client.close()

    def get(self,url):
        allowed_host=urlsplit(url).hostname
        for _ in range(6):
            if urlsplit(url).hostname!=allowed_host:
                raise UnsafeURL('Cross-host redirect blocked; configure the final source URL explicitly')
            if self.fixed_public_sources:
                parsed=urlsplit(url)
                if (parsed.scheme!="https" or parsed.hostname not in {"hacker-news.firebaseio.com", "lemonade-server.ai"}
                        or parsed.username or parsed.password or parsed.port not in (None,443)):
                    raise UnsafeURL("Fixed-source mode permits only HTTPS HN API and Lemonade hosts")
            else:
                validate_url(url)
            host=urlsplit(url).hostname
            for attempt in range(3):
                if self.requests >= self.max_requests or time.monotonic() >= self.deadline:
                    raise ValueError('Run request/time budget exceeded')
                time.sleep(max(0, self.delay-(time.monotonic()-self.last.get(host,0))))
                self.requests+=1
                self.last[host]=time.monotonic()
                try:
                    with self.client.stream('GET',url) as response:
                        if response.status_code in (301,302,303,307,308):
                            if self.fixed_public_sources:
                                raise UnsafeURL('Redirects forbidden in fixed-source mode')
                            url=urljoin(url,response.headers['location'])
                            break
                        # Do not retry deterministic denials (including 403).
                        if response.status_code == 429 or response.status_code >=500:
                            if attempt<2:
                                time.sleep(2**attempt)
                                continue
                        response.raise_for_status()
                        data=bytearray()
                        for chunk in response.iter_bytes(8192):
                            data.extend(chunk)
                            if len(data)>self.max_bytes or time.monotonic()>=self.deadline:
                                raise ValueError('Response size/time budget exceeded')
                        return bytes(data)
                except httpx.TransportError:
                    if attempt==2: raise
                    time.sleep(2**attempt)
            else:
                raise ValueError('Fetch attempts exhausted')
        raise ValueError('Redirect limit exceeded')


def parse_date(value):
    if not value: return None
    try:
        dt=datetime.fromisoformat(value.replace('Z','+00:00'))
    except ValueError:
        try: dt=parsedate_to_datetime(value)
        except (ValueError, TypeError, OverflowError): return None
    if dt.tzinfo is None: dt=dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def parse_feed(raw,url,now,since_hours):
    if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
        raise ValueError('DTD/entity declarations are not accepted')
    root=ET.fromstring(raw)
    def name(node): return node.tag.rsplit('}',1)[-1]
    def field(node,*names):
        return next((''.join(c.itertext()).strip() for c in node if name(c) in names),'')
    cutoff=now-timedelta(hours=since_hours)
    items=[]
    for entry in root.iter():
        if name(entry) not in ('item','entry'): continue
        link=next((c.get('href') or (c.text or '') for c in entry if name(c)=='link' and c.get('rel','alternate')=='alternate'),'')
        if not link: continue
        absolute=urljoin(url,link.strip())
        if urlsplit(absolute).scheme not in ('http','https'): continue
        date=parse_date(field(entry,'pubDate','published','updated','date'))
        if date and (date<cutoff or date>now+timedelta(minutes=5)): continue
        items.append({'title':field(entry,'title'),'url':absolute,'published_at':date.isoformat() if date else None,'text':field(entry,'description','summary','content'),'extraction':'feed_summary','date_status':'known' if date else 'unknown'})
    return items


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ignored=0; self.in_title=False; self.title=[]; self.text=[]; self.links=[]
    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs)
        if tag in ('script','style','noscript'): self.ignored+=1
        if tag=='title': self.in_title=True
        if tag=='a' and attrs.get('href'): self.links.append(attrs['href'])
    def handle_endtag(self,tag):
        if tag in ('script','style','noscript'): self.ignored=max(0,self.ignored-1)
        if tag=='title': self.in_title=False
    def handle_data(self,data):
        if self.in_title: self.title.append(data)
        if not self.ignored and data.strip(): self.text.append(data.strip())


def parse_html(raw,url):
    page=PageParser(); page.feed(raw.decode('utf-8',errors='replace'))
    links=list(dict.fromkeys(urljoin(url,x) for x in page.links if urlsplit(urljoin(url,x)).scheme in ('http','https')))
    return {'title':' '.join(page.title).strip(),'url':url,'text':'\n'.join(page.text),'published_at':None,'date_status':'unknown','extraction':'html_visible_text','links':links}


def parse_article(raw,url):
    try:
        import trafilatura
    except ImportError:
        return parse_html(raw,url)
    value=trafilatura.extract(raw.decode('utf-8',errors='replace'),url=url,output_format='json',with_metadata=True,include_comments=False)
    if not value: return parse_html(raw,url)
    data=json.loads(value); date=parse_date(data.get('date'))
    return {'title':data.get('title') or '', 'url':url,'text':data.get('text') or '', 'published_at':date.isoformat() if date else None,'date_status':'known' if date else 'unknown','extraction':'trafilatura'}


def parse_pdf(raw,url):
    import io
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise RuntimeError('Optional pypdf dependency is not installed') from exc
    reader=PdfReader(io.BytesIO(raw))
    if len(reader.pages)>50: raise ValueError('PDF exceeds 50-page limit')
    text='\n'.join(page.extract_text() or '' for page in reader.pages)
    if not text.strip(): raise ValueError('PDF has no extractable text')
    return {'title':'','url':url,'text':text[:200_000],'published_at':None,'date_status':'unknown','extraction':'pdf_text','pages':len(reader.pages)}
