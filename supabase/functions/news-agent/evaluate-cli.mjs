// Offline evaluation of a saved response. Never performs model or publisher calls.
import {readFile} from 'node:fs/promises';
import {evaluateDecisions} from './evaluation.mjs';
const [casesPath,responsePath]=process.argv.slice(2);
if(!casesPath||!responsePath){console.error('Usage: node evaluate-cli.mjs CASES.json RESPONSE.json');process.exitCode=2;}
else {
 try{
  const cases=JSON.parse(await readFile(casesPath,'utf8'));
  const response=JSON.parse(await readFile(responsePath,'utf8'));
  const report=evaluateDecisions(cases,response.decisions);
  console.log(JSON.stringify(report,null,2));
  process.exitCode=report.complete&&report.correct===report.total?0:1;
 }catch(error){console.error('Invalid evaluation input:',error.message);process.exitCode=2;}
}
