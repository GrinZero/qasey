-- Candidate Change Sets may have advanced this counter before any Case was
-- approved. Rebase it to the first number after approved/active versions;
-- future candidate creation reads this value without consuming it.
UPDATE qasey_case_projects AS project
SET next_case_sequence = COALESCE((
  SELECT MAX(substring(version.case_id FROM '^QASEY-([0-9]+)$')::INTEGER) + 1
  FROM qasey_case_versions AS version
  WHERE version.application_id = project.application_id
    AND version.tenant_id = project.tenant_id
    AND version.status IN ('approved', 'active')
), 1),
updated_at = CURRENT_TIMESTAMP
WHERE project.code = 'QASEY';
