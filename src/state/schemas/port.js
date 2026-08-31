import { defaultStateFile, readState, writeStateImmediate } from "../store.js";

export function setPort(port, { file = defaultStateFile() } = {}) {
  writeStateImmediate(file, { port: Number(port) });
}

export function getPort({ file = defaultStateFile() } = {}) {
  const port = readState(file).port;
  return typeof port === "number" && Number.isInteger(port) && port > 0 ? port : null;
}
