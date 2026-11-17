# Public ETF activity history

This branch stores public market evidence and 15-minute daily signal summaries for the ETF monitor.

- `history.json`: dated summaries, coverage, episodes, and strongest windows.
- `days/YYYY-MM-DD.json`: genuine minute prices/cumulative turnover, historical baseline profiles, and source labels used for replay.

The `main` branch contains the application and archival logic. Its existing GitHub Actions workflow appends/refreshes this branch and publishes the history index with the site. Signals infer price/volume activity; they cannot identify actual buyers or government accounts.
