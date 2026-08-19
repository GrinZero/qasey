-- Qasey 应用主库：保存 Agent Application run/event、平台权限与审计、
-- channel delivery 以及 Qasey MCP OAuth credential。
CREATE DATABASE moego_qasey;

-- Mastra Observability 专用库：保存 traces、metrics、logs 等观测数据。
-- 本仓库不在该库手工创建业务表；数据库结构由 Mastra 初始化和维护。
CREATE DATABASE moego_qasey_observability;
