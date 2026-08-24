-- 为每个 Admin UI 管理的 Slack App installation 保存独立的本地 Runtime Slash Command。
DO $$
BEGIN
  IF current_database() <> 'moego_qasey' THEN
    RAISE EXCEPTION 'Connect to moego_qasey before running this script; current database is %', current_database();
  END IF;
END
$$;

ALTER TABLE platform_slack_app_installations
  ADD COLUMN IF NOT EXISTS dev_runtime_command text NOT NULL DEFAULT '/qasey-local';
