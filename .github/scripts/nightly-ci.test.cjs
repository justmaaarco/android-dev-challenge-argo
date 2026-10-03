const {test}=require('node:test');
const assert=require('node:assert/strict');
const {run,affects,jobMinutes}=require('./nightly-ci.cjs');
const now=new Date('2026-10-03T03:30:00Z');
const sha='b'.repeat(40),old='a'.repeat(40);
function fixture({previous=[],files=[{filename:'src/app.js',sha:'c'.repeat(40)}],status='ahead',budget=200,monthly=[],jobs=[],moving=false,compareError,entries}={}){
 let branchReads=0; const dispatched=[];
 const actions={listWorkflowRuns:async()=>({data:{workflow_runs:previous}}),listWorkflowRunsForRepo:()=>{},listJobsForWorkflowRun:()=>{},createWorkflowDispatch:async x=>dispatched.push(x)};
 const github={rest:{actions,repos:{getBranch:async()=>({data:{commit:{sha:moving&&++branchReads>1?old:sha}}}),compareCommitsWithBasehead:async()=>{if(compareError)throw compareError;return{data:{status,files}}}}},paginate:async fn=>fn===actions.listWorkflowRunsForRepo?monthly:jobs};
 const summary={addHeading(){return this},addRaw(){return this},addTable(rows){assert(Array.isArray(rows[0]));return this},async write(){}};
 const core={summary,info(){},warning(){}};
 const config={branch:'main',baseline_sha:old,monthly_budget_minutes:budget,workflows:entries||[{file:'ci.yml',reserve_minutes:25}]};
 return{github,core,config,context:{repo:{owner:'o',repo:'r'},runId:99},now,dispatched};
}
test('unchanged SHA never dispatches, including a previous failed attempt',async()=>{
 const f=fixture({previous:[{id:1,head_branch:'main',head_sha:sha,status:'completed',conclusion:'failure'}]});
 await run(f);assert.equal(f.dispatched.length,0);
});
test('changed relevant source dispatches exactly once with pinned SHA',async()=>{
 const f=fixture();await run(f);assert.deepEqual(f.dispatched[0].inputs,{nightly_sha:sha});assert.equal(f.dispatched[0].ref,'main');
});
test('irrelevant changes do not dispatch',async()=>{
 const f=fixture({files:[{filename:'README.md'}],entries:[{file:'ci.yml',reserve_minutes:25,paths:['src/**']}]});await run(f);assert.equal(f.dispatched.length,0);
});
test('renames include both old and new path',async()=>{
 const f=fixture({files:[{filename:'docs/old.js',previous_filename:'src/old.js'}],entries:[{file:'ci.yml',reserve_minutes:25,paths:['src/**']}]});await run(f);assert.equal(f.dispatched.length,1);
});
test('300-file truncated comparison conservatively checks',async()=>{
 const f=fixture({files:Array.from({length:300},(_,i)=>({filename:'docs/'+i})),entries:[{file:'ci.yml',reserve_minutes:25,paths:['src/**']}]});await run(f);assert.equal(f.dispatched.length,1);
});
test('active prior run prevents a duplicate',async()=>{
 const f=fixture({previous:[{id:1,head_branch:'main',head_sha:old,status:'in_progress',conclusion:null}]});await run(f);assert.equal(f.dispatched.length,0);
});
test('another branch does not satisfy this branch',async()=>{
 const f=fixture({previous:[{id:1,head_branch:'feature',head_sha:sha,status:'completed'}]});await run(f);assert.equal(f.dispatched.length,1);
});
test('billing denial and skipped jobs do not count as consumed runtime',()=>{
 assert.equal(jobMinutes({runner_id:0,started_at:now.toISOString(),completed_at:now.toISOString(),labels:['macos-26']},now),0);
});
test('all attempts and rounding contribute to quota',async()=>{
 const f=fixture({budget:100,monthly:[{id:1,status:'completed'}],jobs:[{runner_id:1,started_at:'2026-10-03T00:00:00Z',completed_at:'2026-10-03T00:03:01Z',labels:['macos-26']}]});await run(f);assert.equal(f.dispatched.length,0);assert.equal((await run(f)).used,40);
});
test('budget reserves multiple dispatched jobs without oversubscription',async()=>{
 const f=fixture({budget:100,entries:[{file:'a.yml',reserve_minutes:25},{file:'b.yml',reserve_minutes:25}]});await run(f);assert.equal(f.dispatched.length,1);
});
test('active unknown manual release reserves entire budget',async()=>{
 const f=fixture({monthly:[{id:3,path:'.github/workflows/release.yml',status:'in_progress'}]});await run(f);assert.equal(f.dispatched.length,0);
});
test('branch race fails without dispatch',async()=>{
 const f=fixture({moving:true});await assert.rejects(run(f),/Branch changed/);assert.equal(f.dispatched.length,0);
});
test('API authorization failures fail closed',async()=>{
 const f=fixture({compareError:Object.assign(new Error('denied'),{status:403})});await assert.rejects(run(f),/denied/);assert.equal(f.dispatched.length,0);
});
test('force-push history loss selects checks conservatively',async()=>{
 const f=fixture({compareError:Object.assign(new Error('gone'),{status:404})});await run(f);assert.equal(f.dispatched.length,1);
});
test('policy migration alone does not wake dormant builds',async()=>{
 const f=fixture({files:[{filename:'.github/workflows/ci.yml',sha:'c'.repeat(40)},{filename:'.github/nightly-ci.json'}]});f.config.migration_blobs={'.github/workflows/ci.yml':'c'.repeat(40)};await run(f);assert.equal(f.dispatched.length,0);
});
test('future workflow edits are detected',async()=>{
 const f=fixture({files:[{filename:'.github/workflows/ci.yml',sha:'d'.repeat(40)}]});f.config.migration_blobs={'.github/workflows/ci.yml':'c'.repeat(40)};await run(f);assert.equal(f.dispatched.length,1);
});
test('dispatch metadata uses the actual pinned checkout, not a later branch SHA',async()=>{
 const f=fixture({previous:[{id:1,head_branch:'main',head_sha:sha,display_title:'CI / '+old,status:'completed',conclusion:'success'}]});await run(f);assert.equal(f.dispatched.length,1);
});
test('path globs handle root/nested markdown, stars and negation',()=>{
 assert.equal(affects(['README.md'],{ignore:['**/*.md']}),false);
 assert.equal(affects(['src/a.md'],{ignore:['**/*.md']}),false);
 assert.equal(affects(['package-lock.json'],{paths:['package*.json']}),true);
 assert.equal(affects(['src/test.js'],{paths:['src/**','!src/test.js']}),false);
});
