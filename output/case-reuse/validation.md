# Case reuse and review validation — 2026-09-07

## Actual application flow

- Conversation: http://localhost:4111/admin/apps/qasey?conversation=ab36c863-a7ef-460d-a1f4-e73543bada7f
- Run: `bdb545f2-e976-495b-931f-9f69783f49f0` — `succeeded`.
- Existing QASEY-7, QASEY-8, QASEY-9 v2 were reused from another conversation. Each still has exactly two text versions; no v3 or new text Review Plan was created.
- E2E author, independent verifier, and final verifier completed successfully. All three results are `passed` and `approved`; evidence was reviewed and approved through the Case detail UI.
- E2E PR: https://github.com/GrinZero/qasey/pull/15 — ready for review, open, unmerged. Head: `eb9a3195aa5cc9e340ce5c9b59d462e78ed28d9d`.
- Review against the preceding E2E implementation confirms that inlining the extracted width assertion helper produces identical tests. Acceptance assertions and text hashes are preserved.

## UI and evidence checks

- Library row click opens current Case detail; backdrop closes it.
- Current and historical versions have separate status projections; old failures remain historical.
- Separate review inbox and shared Case detail approval controls.
- Real video step 2 seek: target 0.663813s, observed 0.664254s.
- Embedded Trace really selected Step 02 and Step 04 (verified selected tree action).
- Enlarged evidence keeps step navigation; Escape closes only enlarged evidence.
- At 1280×720, enlarged video, native controls, and independently scrolling steps fit the viewport. Screenshot: [fullscreen video](fullscreen-video.png).
- QASEY-8 Trace steps 2/4 and QASEY-9 steps 3/4 were also reviewed through the real application before approval.
- Video offsets align to the first Trace screencast frame; possible first-frame offset is disclosed. Missing or ambiguous mappings remain manual, not synthesized.

## Checks

- `pnpm check`: 779 passed, 8 skipped; API and worker builds passed.
- `pnpm check:open-source`: 477 worktree files passed.
- Final TypeScript check and frontend production build passed.
- Focused browser regressions and the real authenticated `verify-detail.mjs` check passed.
- `git diff --check` passed.

Application fixes are in the shared working tree and synchronized to the local preview. They have not been committed; the E2E PR above was produced by the actual agent workflow. This local report and runtime evidence must not be included in an open-source commit.
