#!/usr/bin/env node
import { evaluateBundle } from './lib/shadow/gate.mjs'
import { readJson } from './lib/shadow/evidence.mjs'
import { addHumanReview, shadowReport } from './lib/shadow/report.mjs'

const [command, dir, labelFile] = process.argv.slice(2)
try {
  if (!dir) throw new Error('Expected a bundle directory or report root')
  if (command === 'evaluate') console.log(JSON.stringify(await evaluateBundle(dir), null, 2))
  else if (command === 'report') console.log(JSON.stringify(shadowReport(dir), null, 2))
  else if (command === 'label' && labelFile) console.log(addHumanReview(dir, readJson(labelFile)))
  else throw new Error('Usage: shadow-gate.mjs evaluate <bundle> | report <shadow-root> | label <bundle> <review.json>')
} catch {
  console.error('Shadow operation failed. Check arguments, sealed evidence, and configuration. No incubator action was taken.')
  process.exitCode = 1
}
