# Demo Scenarios

Four scenario fixtures that demonstrate the key product flows of the Assay Harness.
Each scenario is a harness JSON input paired with its mapped NDJSON output, compared
against a clean baseline to show what the regression detector surfaces.

Run all scenarios:

```bash
./demo/run-scenarios.sh
```

---

## Scenario 1: Clean Baseline (no regressions)

**File:** `fixtures/scenarios/clean-baseline.harness.json`

**What it demonstrates:**
The "nothing changed" path. This is an identical copy of `fixtures/valid.harness.json`
and serves as the baseline for all comparisons. When compared against itself, the
compare tool reports zero regressions and exits with code 0.

**Expected compare output:**
```
Status: OK
Summary: No changes detected
```

**What a reviewer should look for:**
- Exit code 0 confirms no regressions
- No denials, no new approvals, no hash mismatches
- This is the steady state -- any PR that produces this output is safe to merge

---

## Scenario 2: PR Introduces New Approval

**File:** `fixtures/scenarios/new-approval.harness.json`

**What it demonstrates:**
A PR adds a new tool (`deploy_to_staging`) that requires approval. The harness captures
two interruptions instead of one, and the process summary shows `approval_count=2`.
Compare flags this as a regression because new approval requirements change the
security surface.

**Expected compare output:**
```
Status: REGRESSION DETECTED
Summary: REGRESSION: 1 new approval(s), event count delta: +1,
         1 hash mismatch(es), 2 process counter change(s)

New Approvals:
- deploy_to_staging (policy: harness-mvp-policy@1.0)

Process Summary Delta:
| approval_count   | 1 | 2 | +1 |
| total_tool_calls | 3 | 4 | +1 |
```

**What a reviewer should look for:**
- The "New Approvals" section names the exact tool that now requires approval
- The process summary delta shows the approval count increased
- The hash mismatch on seq 0 is expected (the interruption event changed)
- A reviewer should verify the new tool genuinely needs approval gating

---

## Scenario 3: Policy Change Causes Deny Regression

**File:** `fixtures/scenarios/deny-regression.harness.json`

**What it demonstrates:**
A policy tightening: `write_file` was previously `require_approval` but is now `deny`.
The process summary shows `denied_action_count=1` and `approval_count=0`. Compare
flags this as a regression because a previously-approvable tool is now fully blocked.

**Expected compare output:**
```
Status: REGRESSION DETECTED
Summary: REGRESSION: 1 new denial(s), 1 removed approval(s),
         1 hash mismatch(es), 2 process counter change(s)

New Denials:
- write_file (policy: harness-mvp-policy@1.0)

Removed Approvals:
- write_file (policy: harness-mvp-policy@1.0)

Process Summary Delta:
| approval_count      | 1 | 0 | -1 |
| denied_action_count | 0 | 1 | +1 |
```

**What a reviewer should look for:**
- "New Denials" shows which tool is now blocked
- "Removed Approvals" confirms the tool moved from require_approval to deny
- The `denied_action_count` delta going from 0 to 1 is the key regression signal
- A reviewer should verify this is an intentional policy change, not a misconfiguration

---

## Scenario 4: Resume with Policy Snapshot Mismatch

**File:** `fixtures/scenarios/policy-drift-resume.harness.json`

**What it demonstrates:**
The policy snapshot hash in the `resumed` section differs from the top-level
`policy_snapshot_hash`. This means the policy changed between the interruption and
the resume. The mapper does not enforce this consistency (it maps faithfully), but
compare detects the content change via hash mismatch on the resumed-run event.

**Expected compare output:**
```
Status: REGRESSION DETECTED
Summary: REGRESSION: 1 hash mismatch(es)

Hash Mismatches:
- seq 2 (example.placeholder.harness.resumed-run)
  - baseline: sha256:...
  - candidate: sha256:...
```

**What a reviewer should look for:**
- The hash mismatch on the `resumed-run` event type
- No denial or approval changes (the policy decisions themselves are identical)
- This scenario surfaces policy drift -- the approval was granted under a different
  policy than the one active at interruption time
- In production, this should trigger a re-evaluation of the resume decision
