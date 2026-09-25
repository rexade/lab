// SSE fan-out channels. Each channel is a set of open responses that receive
// a bare "update" ping; clients re-fetch the JSON they care about.
import { broadcastSse, openSseStream } from './util.js'

const incubatorClients = new Set()
const runLogClients = new Set()

export function subscribeIncubatorUpdates(req, res) {
  openSseStream(req, res, incubatorClients)
}

export function notifyIncubatorClients() {
  broadcastSse(incubatorClients)
}

export function subscribeRunLogUpdates(req, res) {
  openSseStream(req, res, runLogClients)
}

export function notifyRunLogClients() {
  broadcastSse(runLogClients)
}
