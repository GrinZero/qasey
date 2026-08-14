#!/usr/bin/env python3
"""分析 Qasey n8n execution 的证据扇出与上下文成本。

为什么不用 jq / JSON.parse：n8n 的 runData 里同一个对象存在**重复 JSON key**
（一次 execution 里 response 出现 61 次、hints 197 次）。标准 JSON 解析是
last-wins，jq 也是，于是同一个 run 里多个 response 只能看到最后一个 —— 而
最后一个往往是第一次全文检索的旧 blob。直接用 jq 读会误判成「工具返回了
陈旧缓存」。这里用 object_pairs_hook 保留全部重复值再判定。

用法:
  python3 analyze-qasey-execution.py <execId>        # 走 n8n-cli 拉取
  python3 analyze-qasey-execution.py -f <file.json>  # 读已落盘的 payload
"""
import json
import re
import subprocess
import sys
from collections import Counter

JQL_NODE = "Search Jira issues with JQL"
MCP_NODE = "Atlassian MCP"
KEY_RE = re.compile(r"\b[A-Z]{2,4}-\d{2,5}\b")
TOTAL_RE = re.compile(r'"total"\s*:\s*(\d+)')


def hook(pairs):
    """把每个 JSON object 变成 key -> [所有值]，保留重复 key。"""
    d = {}
    for k, v in pairs:
        d.setdefault(k, []).append(v)
    return d


def vals(obj, key):
    """取 obj[key] 的全部变体；obj 可能不是 dict。"""
    if isinstance(obj, dict):
        return obj.get(key, [])
    return []


def descend(obj, *keys):
    """沿 keys 逐层下钻，每层取第一个变体，遇 list 取第 0 项。"""
    cur = obj
    for k in keys:
        if isinstance(cur, list):
            cur = cur[0] if cur else None
        got = vals(cur, k)
        if not got:
            return None
        cur = got[0]
    return cur


def collect(obj, key, acc):
    """递归收集所有 key 下的字符串值（含重复 key 的每个变体）。

    n8n 的 MCP 工具返回是 response: [{type:[...], text:[...]}]，内容在
    嵌套的 text 里而不是 response 本身，所以命中 key 后要继续下钻取文本。
    """
    if isinstance(obj, dict):
        for k, variants in obj.items():
            for v in variants:
                if k == key:
                    if isinstance(v, str):
                        acc.append(v)
                    else:
                        # response/content 这类结构体：把内部所有 text 拼起来
                        texts = []
                        collect_text(v, texts)
                        if texts:
                            acc.append("".join(texts))
                collect(v, key, acc)
    elif isinstance(obj, list):
        for v in obj:
            collect(v, key, acc)


def collect_text(obj, acc):
    """收集结构体里所有 text 字段的字符串内容。"""
    if isinstance(obj, dict):
        for k, variants in obj.items():
            for v in variants:
                if k == "text" and isinstance(v, str):
                    acc.append(v)
                else:
                    collect_text(v, acc)
    elif isinstance(obj, list):
        for v in obj:
            collect_text(v, acc)


def count_dup_keys(obj, acc):
    if isinstance(obj, dict):
        for k, variants in obj.items():
            if len(variants) > 1:
                acc[k] += len(variants) - 1
            for v in variants:
                count_dup_keys(v, acc)
    elif isinstance(obj, list):
        for v in obj:
            count_dup_keys(v, acc)


def analyze(doc):
    run_data = descend(doc, "data", "resultData", "runData") or {}
    err = descend(doc, "data", "resultData", "error")

    out = {
        "execId": (vals(doc, "id") or ["?"])[0],
        "status": (vals(doc, "status") or ["?"])[0],
        "startedAt": (vals(doc, "startedAt") or [None])[0],
        "stoppedAt": (vals(doc, "stoppedAt") or [None])[0],
        "errName": (vals(err, "name") or [None])[0] if err else None,
        "jsonSizeBytes": (vals(doc, "jsonSizeBytes") or [0])[0],
    }

    dups = Counter()
    count_dup_keys(run_data, dups)
    out["dupKeys"] = dict(dups.most_common(6))

    node_runs = {}
    for node, variants in run_data.items():
        runs = variants[0] if variants else []
        node_runs[node] = runs if isinstance(runs, list) else []
    out["nodeRunCounts"] = {n: len(r) for n, r in sorted(
        node_runs.items(), key=lambda kv: -len(kv[1])) if r}

    # ---- JQL: 每个 run 的 ask 与 response.total 是否一致 ----
    jql = []
    for i, run in enumerate(node_runs.get(JQL_NODE, [])):
        asks, resps = [], []
        collect(run, "query", asks)
        collect(run, "JQL", asks)
        collect(run, "response", resps)
        resps = [r for r in resps if r]
        totals = {int(m.group(1)) for r in resps for m in [TOTAL_RE.search(r)] if m}
        asked = {}
        for a in asks:
            asked[a] = len(set(KEY_RE.findall(a)))
        # 真实响应 = 长度最大的变体（旧 blob 通常更短且反复出现）
        real = max(resps, key=len) if resps else ""
        real_total = TOTAL_RE.search(real)
        jql.append({
            "idx": i,
            "askVariants": asked,
            "responseVariants": len(set(resps)),
            "realChars": len(real),
            "realTotal": int(real_total.group(1)) if real_total else None,
            "allTotals": sorted(totals),
        })
    out["jql"] = jql

    # ---- 单 key 拉取的重复 ----
    fetched = []
    for run in node_runs.get(MCP_NODE, []):
        ids = []
        collect(run, "issueIdOrKey", ids)
        for k in dict.fromkeys(ids):
            fetched.append(k)
    c = Counter(fetched)
    out["fetchCalls"] = len(fetched)
    out["fetchDistinct"] = len(c)
    out["refetched"] = {k: n for k, n in c.most_common() if n > 1}
    out["wastedFetches"] = sum(n - 1 for n in c.values() if n > 1)

    # ---- 进入上下文的证据总量（按内容去重，避免重复 key artifact 重复计数）----
    per_node, grand = {}, 0
    for node, runs in node_runs.items():
        seen, total = set(), 0
        for run in runs:
            got = []
            collect(run, "response", got)
            for r in got:
                if r and r not in seen:
                    seen.add(r)
                    total += len(r)
        if total:
            per_node[node] = total
            grand += total
    out["evidenceCharsPerNode"] = dict(
        sorted(per_node.items(), key=lambda kv: -kv[1]))
    out["evidenceCharsTotal"] = grand

    touched = set()
    for run in node_runs.get(JQL_NODE, []):
        s = []
        collect(run, "query", s)
        collect(run, "JQL", s)
        for x in s:
            touched |= set(KEY_RE.findall(x))
    touched |= set(fetched)
    out["distinctKeysTouched"] = len(touched)

    return out


def load(arg, from_file):
    if from_file:
        raw = open(arg).read()
    else:
        raw = subprocess.run(
            ["n8n-cli", "execution", "get", arg, "--includeData", "--json"],
            capture_output=True, text=True, check=True).stdout
    return json.loads(raw, object_pairs_hook=hook)


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)
    from_file = args[0] == "-f"
    target = args[1] if from_file else args[0]
    print(json.dumps(analyze(load(target, from_file)),
                     indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
