module.exports = {
  // Relative paths are resolved from the backend folder.
  dbPath: "/var/data/bingo.sqlite",
  // Auto-close rooms if they have not been updated in this many days.
  roomRetentionDays: 30,
  // How often to run cleanup (in minutes).
  cleanupIntervalMinutes: 60,
};
