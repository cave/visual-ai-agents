// Works out which sessions newly have something for you to do, by comparing two snapshots of the office.
// Used by the desktop app for notifications and the Dock badge.

// prev: Map of pid -> state from the last look (null on the very first look). Returns the new map and
// a list of { pid, name, project, kind: 'needs-you' | 'done', text } for sessions that just changed.
function changes(prev, sessions) {
  const next = new Map(sessions.map((s) => [s.pid, s.state]));
  const events = [];
  if (prev) {
    for (const s of sessions) {
      const before = prev.get(s.pid);
      if (s.state === 'needs-you' && before !== 'needs-you') {
        events.push({ pid: s.pid, name: s.name, project: s.project, kind: 'needs-you', text: s.waitingFor ? `Needs you: ${s.waitingFor}` : 'Needs your answer' });
      } else if (s.state === 'done' && before === 'working') {
        // Only a session seen working counts; one that was already idle when the app started is old news.
        events.push({ pid: s.pid, name: s.name, project: s.project, kind: 'done', text: s.jobs && s.jobs.length ? 'Finished its turn and left a job running' : 'Finished. Your turn.' });
      }
    }
  }
  return { next, events };
}

module.exports = { changes };
