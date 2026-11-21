#!/usr/bin/env node
import { openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { evaluateCampaign } from './editorial-campaign.mjs';
function readCampaign(path) {
  const limit=10*1024*1024;
  let descriptor;
  try {
    descriptor=openSync(path, constants.O_RDONLY|constants.O_NONBLOCK);
    const stat=fstatSync(descriptor);
    if (!stat.isFile())throw Error('Campaign must be a regular file');
    if (stat.size>limit)throw Error('Campaign exceeds 10 MiB limit');
    const buffer=Buffer.alloc(limit+1);
    let used=0;
    while (used<buffer.length) {
      const count=readSync(descriptor, buffer, used, buffer.length-used, null);
      if (count===0)break;
      used+=count;
    }
    if (used>limit)throw Error('Campaign exceeds 10 MiB limit');
    return JSON.parse(buffer.toString('utf8', 0, used));
  } finally {
    if (descriptor!==undefined)closeSync(descriptor);
  }
}
try {
  if (process.argv.length!==3)throw Error('Usage: node editorial-campaign-cli.mjs campaign.json');
  const report=evaluateCampaign(readCampaign(process.argv[2]));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode=report.reportedEvidencePass?0:1;
} catch (error) {
  console.error(JSON.stringify({
    error:error.message,
    publishingEnabled:false,
    modelQualityProven:false
  }));
  process.exitCode=2;
}
