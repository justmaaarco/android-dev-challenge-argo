# CI usage policy

One checker runs nightly at 03:11 Europe/London on `main`. The checker dispatches existing tests only when their relevant files changed since their last attempt on that branch. Failed/cancelled commits are not retried every night. Manual workflow runs remain available for diagnosis and retries.

The checker pins checkout to the compared source SHA, prevents overlapping dispatch checks, and reserves each candidate's maximum job time plus five minutes per job for cleanup. Private-repository admission uses conservative Linux/Windows/macOS weights of 1/2/10, all current-month jobs and attempts across branches, and two minutes per remaining nightly checker. The budget here is unlimited for free standard public-repository runners. Deferred work is reported in the checker summary and reconsidered on later nights. This is conservative admission control, not an account billing API; concurrent manual runs can still consume the shared allowance. Keep the account's $0 stop-usage budget.

Unchanged nights consume only the short Linux checker. Source-history failures fail closed; divergent/incomplete diffs conservatively select tests. Configuration installation alone does not rebuild dormant projects. Existing release/tag workflows and manual release inputs remain explicit; deployment-on-every-push workflows are now manual. Aestha retains its required PR quality gate.

Nightly CI does not publish apps or alter Wheerli's existing Cloudflare/Xcode Cloud change-only TestFlight scheduler. Gyoza checks Linux nightly; select cross_platform for manual Windows/macOS compatibility coverage.
