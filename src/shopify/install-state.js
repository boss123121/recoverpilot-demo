const pendingInstallStates = new Map();

function saveInstallState(state, payload) {
  pendingInstallStates.set(state, payload);
}

function consumeInstallState(state) {
  const payload = pendingInstallStates.get(state);
  pendingInstallStates.delete(state);
  return payload || null;
}

module.exports = {
  consumeInstallState,
  saveInstallState
};
