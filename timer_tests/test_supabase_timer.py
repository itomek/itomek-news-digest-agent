import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('timer',Path(__file__).parents[1]/'tools/supabase_timer.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class TimerTests(unittest.TestCase):
 def test_disabled_does_nothing(self):
  self.assertEqual(m.run({},lambda *args: self.fail('network')), 'disabled')
 def test_missing_secret_fails_before_any_request(self):
  with self.assertRaises(ValueError):m.run({'WARPCORE_TIMER_ENABLED':'true'},lambda *args:self.fail('network'))
 def test_only_fixed_destinations_and_separate_tokens(self):
  calls=[]
  def send(url,headers):calls.append((url,headers));return 200
  env={'WARPCORE_TIMER_ENABLED':'true','WARPCORE_GATEWAY_ANON_JWT':'a'*64,'WARPCORE_COLLECT_TOKEN':'b'*32,'WARPCORE_PUBLISH_TOKEN':'c'*32}
  self.assertEqual(m.run(env,send),'completed');self.assertEqual(len(calls),2)
  self.assertEqual(calls[0][0],'https://eedfyviypptfpghyffip.supabase.co/functions/v1/news-collect')
  self.assertEqual(calls[1][1]['x-warpcore-token'],'c'*32)
 def test_failure_stops_without_retry_or_publish(self):
  calls=[]
  def fail(*args):calls.append(args);raise TimeoutError()
  env={'WARPCORE_TIMER_ENABLED':'true','WARPCORE_GATEWAY_ANON_JWT':'a'*64,'WARPCORE_COLLECT_TOKEN':'b'*32,'WARPCORE_PUBLISH_TOKEN':'c'*32}
  with self.assertRaises(TimeoutError):m.run(env,fail)
  self.assertEqual(len(calls),1)
 def test_redirect_is_not_followed(self):
  with self.assertRaises(RuntimeError):m.NoRedirect().redirect_request(None,None,302,'redirect',{},'https://evil.example')
 def test_publisher_rate_limit_is_not_retried(self):
  calls=[]
  def sender(*args):calls.append(args);return 200 if len(calls)==1 else 429
  env={'WARPCORE_TIMER_ENABLED':'true','WARPCORE_GATEWAY_ANON_JWT':'a'*64,'WARPCORE_COLLECT_TOKEN':'b'*32,'WARPCORE_PUBLISH_TOKEN':'c'*32}
  self.assertEqual(m.run(env,sender),'publisher_hour_already_reserved');self.assertEqual(len(calls),2)
 def test_shared_tokens_rejected_before_requests(self):
  env={'WARPCORE_TIMER_ENABLED':'true','WARPCORE_GATEWAY_ANON_JWT':'a'*64,'WARPCORE_COLLECT_TOKEN':'b'*32,'WARPCORE_PUBLISH_TOKEN':'b'*32}
  with self.assertRaises(ValueError):m.run(env,lambda *args:self.fail('network'))
 def test_send_uses_120_second_socket_timeout_once(self):
  with patch.object(m.urllib.request,'build_opener') as build:
   opener=build.return_value
   opener.open.return_value.__enter__.return_value.status=200
   self.assertEqual(m.send(m.BASE+'news-collect',{}),200)
   self.assertEqual(opener.open.call_count,1)
   self.assertEqual(opener.open.call_args.kwargs['timeout'],120)
 def test_workflow_has_five_minute_bound_and_no_schedule(self):
  text=(Path(__file__).parents[1]/'.github/workflows/warpcore-timer.yml').read_text()
  self.assertIn('timeout-minutes: 5',text)
  self.assertNotIn('schedule:',text)
