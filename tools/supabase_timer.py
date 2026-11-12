"""Trigger only; all collection/editorial/publication processing stays in Supabase."""
import os
import sys
import urllib.error
import urllib.request

BASE = 'https://eedfyviypptfpghyffip.supabase.co/functions/v1/'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('Redirect refused')


def send(url, headers):
    # Inherited proxy/TLS settings; no retries, no response body or credentials logged.
    request = urllib.request.Request(url, data=b'{}', method='POST', headers=headers)
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=120) as response:
            return response.status
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        return status


def run(env, sender=send):
    if env.get('WARPCORE_TIMER_ENABLED') != 'true':
        return 'disabled'
    keys = ('WARPCORE_GATEWAY_ANON_JWT', 'WARPCORE_COLLECT_TOKEN', 'WARPCORE_PUBLISH_TOKEN')
    if any(not isinstance(env.get(k), str) or len(env[k]) < 32 for k in keys):
        raise ValueError('Required timer authentication is missing')
    if env[keys[1]] == env[keys[2]]:
        raise ValueError('Collector and publisher tokens must be distinct')
    for endpoint, token in [('news-collect', keys[1]), ('news-curate', keys[2]), ('news-publish', keys[2])]:
        status = sender(BASE + endpoint, {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + env[keys[0]],
            'x-warpcore-token': env[token],
        })
        if status == 429 and endpoint == 'news-publish':
            return 'publisher_hour_already_reserved'
        if status != 200:
            raise RuntimeError('Supabase invocation failed')
    return 'completed'


if __name__ == '__main__':
    try:
        print(run(os.environ))
    except Exception:
        # No exception repr, HTTP body, URL query, environment or header values.
        print('Timer failed; inspect sanitized Supabase status. No retry attempted.', file=sys.stderr)
        sys.exit(1)
