'use strict';

// A single short checker dispatches CI; no cache, marker commits, or secret PAT.
function glob(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; out += '(?:.*/)?'; }
      else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(out + '$');
}

function included(file, patterns) {
  let match = false;
  for (const p of patterns) {
    if (glob(p.startsWith('!') ? p.slice(1) : p).test(file)) match = !p.startsWith('!');
  }
  return match;
}

function affects(files, entry) {
  if (files === null) return true; // Incomplete comparison: do not silently omit tests.
  return files.some(file => (!entry.paths || included(file, entry.paths)) &&
    (!entry.ignore || !included(file, entry.ignore)));
}

function jobMinutes(job, now) {
  // Conservative allowance planning: Linux 1, Windows 2, macOS 10.
  if (!job.runner_id || !job.started_at || job.conclusion === 'skipped') return 0;
  const labels = (job.labels || []).join(' ').toLowerCase();
  const weight = labels.includes('macos') ? 10 : labels.includes('windows') ? 2 : 1;
  const end = job.completed_at ? Date.parse(job.completed_at) : now.getTime();
  return Math.max(0, Math.ceil((end - Date.parse(job.started_at)) / 60000)) * weight;
}

async function run({github, context, core, config, now = new Date()}) {
  const repo = context.repo;
  const branch = config.branch;
  const head = (await github.rest.repos.getBranch({...repo, branch})).data.commit.sha;
  const candidates = [];
  const decisions = [];
  for (const entry of config.workflows) {
    const {data} = await github.rest.actions.listWorkflowRuns({
      ...repo, workflow_id: entry.file, branch, per_page: 100
    });
    // Count failed/cancelled attempts too: unchanged code must not retry every night.
    const previous = data.workflow_runs.find(r => r.id !== context.runId &&
      r.head_branch === branch && r.conclusion !== 'skipped');
    // Dispatch runs may start after the branch moves. Their run title records
    // the actual checkout SHA, so the new commit cannot be mistaken for tested code.
    const previousSha = previous?.display_title?.match(/ \/ ([a-f0-9]{40})$/)?.[1] || previous?.head_sha;
    if (previousSha === head) {
      decisions.push([entry.file, 'unchanged / already attempted']);
      continue;
    }
    if (previous && previous.status !== 'completed') {
      decisions.push([entry.file, 'previous run still active']);
      continue;
    }
    const base = previousSha || config.baseline_sha;
    let files = null;
    if (base === head) files = [];
    else {
      try {
        const {data: diff} = await github.rest.repos.compareCommitsWithBasehead({
          ...repo, basehead: `${base}...${head}`, per_page: 100
        });
        if (diff.status === 'identical') files = [];
        else if (diff.status === 'ahead' && diff.files && diff.files.length < 300) {
          files = diff.files.flatMap(f => [f.filename, f.previous_filename].filter(Boolean));
          // Installing the policy alone should not wake old projects. Ignore only
          // files still identical to this migration, not future workflow edits.
          const initial = config.migration_blobs || {};
          files = files.filter(f => !['.github/nightly-ci.json', '.github/CI-USAGE.md', '.github/scripts/nightly-ci.cjs', '.github/scripts/nightly-ci.test.cjs', '.github/workflows/nightly-ci.yml'].includes(f) &&
            !diff.files.some(d => d.filename === f && initial[f] === d.sha));
        }
      } catch (error) {
        if (error.status !== 404 && error.status !== 409) throw error;
        core.warning(`${entry.file}: history diverged; checking conservatively`);
      }
    }
    if (!affects(files, entry)) {
      decisions.push([entry.file, 'no relevant file changes']);
      continue;
    }
    candidates.push(entry);
  }

  let used = 0;
  if (candidates.length && config.monthly_budget_minutes !== null) {
    const month = now.toISOString().slice(0, 7) + '-01';
    const runs = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, {
      ...repo, created: `>=${month}`, per_page: 100
    });
    if (runs.length > 1000) throw new Error('Too much monthly history; refusing an unverified budget.');
    // Read every attempt, including manual jobs and other branches/release jobs.
    for (let i = 0; i < runs.length; i += 6) {
      const groups = await Promise.all(runs.slice(i, i + 6).map(async r => {
        if (r.id === context.runId) return 0;
        if (r.status !== 'completed') {
          const known = config.workflows.find(e => r.path?.endsWith('/' + e.file));
          return known?.reserve_minutes || config.monthly_budget_minutes;
        }
        const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
          ...repo, run_id: r.id, filter: 'all', per_page: 100
        });
        return jobs.reduce((total, job) => total + jobMinutes(job, now), 0);
      }));
      used += groups.reduce((sum, n) => sum + n, 0);
    }
  }
  const days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  // Allow up to two Linux minutes for each remaining nightly checker.
  const checkerReserve = 2 * (days - now.getUTCDate() + 1);
  let reserved = 0;
  for (const entry of candidates) {
    if (config.monthly_budget_minutes !== null &&
        used + reserved + checkerReserve + entry.reserve_minutes > config.monthly_budget_minutes) {
      decisions.push([entry.file, 'deferred: monthly CI budget']);
      core.warning(`${entry.file}: deferred; ${used} used, ${reserved} reserved, ${checkerReserve} checker reserve, ${entry.reserve_minutes} needed, ${config.monthly_budget_minutes} limit`);
      continue;
    }
    // Do not dispatch a moving branch after checking a different commit.
    const current = (await github.rest.repos.getBranch({...repo, branch})).data.commit.sha;
    if (current !== head) throw new Error('Branch changed during the check; defer until the next nightly check.');
    await github.rest.actions.createWorkflowDispatch({
      ...repo, workflow_id: entry.file, ref: branch, inputs: {nightly_sha: head}
    });
    reserved += entry.reserve_minutes;
    decisions.push([entry.file, `dispatched ${head.slice(0, 12)}`]);
  }
  core.info(JSON.stringify({branch, head, used, reserved, decisions}));
  await core.summary.addHeading('Nightly change-only CI')
    .addRaw(`Branch: ${branch}; source: ${head}; weighted minutes used: ${used}.\n\n`)
    .addTable([[{data: 'Workflow', header: true}, {data: 'Decision', header: true}], ...decisions]).write();
  return {used, reserved, decisions};
}

module.exports = {run, glob, affects, jobMinutes};
