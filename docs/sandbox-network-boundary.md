# Sandbox network boundary

The production sandbox uses four complementary controls:

1. each session and Code Task executes inside a bubblewrap mount/PID boundary;
2. sandbox processes and browsers receive one dedicated egress proxy;
3. Playwright contexts enforce an exact-origin browser allowlist; and
4. Kubernetes denies direct pod traffic except for the sandbox service and the
   dedicated egress proxy; the Sandbox has no DNS egress path.

None of these controls should be removed because another one is present. Proxy
environment variables are application configuration, browser routing is a
browser-layer guard, and Kubernetes NetworkPolicy is the network-layer guard.

## Process isolation

Production startup requires `QASEY_SANDBOX_ISOLATION=bwrap`. Each interactive
session receives a private repository and writable HOME. Each Code Task receives
a worker boundary containing only its independent checkout plus trusted control
and artifact paths; repository-controlled install and Playwright checks execute
inside a second PID/mount namespace that contains only the required checkout,
read-only secondary repositories/runtime closure, and private check output. The
control-plane signing key, GitHub credential, host temporary files, shared Git
mirror, sibling workspaces, and service image source tree are not mounted or
copied into untrusted task code.

Headless Chromium is launched in a separate per-browser PID/mount namespace,
not in the generic shell boundary and not directly as an uncontained host child.
It receives a fresh writable run directory and HOME; the shell repository,
persisted cookie file, other browser runs, and task state are absent. Cookie
state and frame snapshots are read or atomically replaced by the trusted
runtime. The optional shared desktop/Xvfb backend is a local
development aid and is rejected when `NODE_ENV=production`; production desktop
automation needs a dedicated per-session VM or container backend before it can
be supported.

CI and release verification run a real fixed-check Code Task and Chromium frame
capture against the exact Sandbox OCI candidate. The smoke proves independent
Git objects, read-only secondary repositories, nested PID isolation, absence of
credentials from every visible `/proc/*/environ`, browser/task invisibility from
the generic shell, and symlink-safe frame replacement while host/sibling
sentinels remain unchanged. Bubblewrap is still one layer: retain a non-root container,
seccomp/capability restrictions, resource quotas, authenticated claims, and the
network controls below.

Production permits exactly one active untrusted session per Sandbox process.
Scale the Sandbox Deployment horizontally and let the pod/VM runtime enforce
CPU, memory, PID, and ephemeral-storage limits. This bounds a
resource-exhaustion failure to one tenant; bubblewrap namespaces and the
in-process hard deadline do not provide cgroup-style resource isolation.

## Required production configuration

Production startup fails unless both variables are set:

```dotenv
QASEY_SANDBOX_EGRESS_PROXY_URL=http://10.96.0.50:3128
QASEY_SANDBOX_BROWSER_ALLOWED_ORIGINS=https://app.example.com,https://api.example.com
```

`QASEY_SANDBOX_EGRESS_PROXY_URL` must be an `http` or `https` URL without URL
credentials, a path, a query, or a fragment. Put proxy authentication and
upstream credentials in the proxy's own secret store; do not put them in this
URL. The runtime normalizes the URL and injects it as `HTTP_PROXY`,
`HTTPS_PROXY`, and `ALL_PROXY` for session commands, code-task workers,
repository Git operations, and headless/desktop Chromium. It replaces any
caller-supplied values for those variables.

The example uses the proxy Service's reserved ClusterIP deliberately. HTTP
proxy clients send destination hostnames to the proxy, so the Sandbox does not
need to resolve Internet names itself. Reserve an address from the target
cluster's Service CIDR on the real proxy Service and inject that address through
deployment configuration; `10.96.0.50` is only an adaptation placeholder.

The runtime sets `NO_PROXY` only to numeric loopback plus `localhost`, which is
needed by repository-local test servers and browser-driver traffic. Do not add
cluster services, metadata endpoints, private networks, or public domains to
this bypass.

`QASEY_SANDBOX_BROWSER_ALLOWED_ORIGINS` is a comma-separated, non-empty list in
production. Each entry must be an `http` or `https` origin without URL
credentials, a non-root path, a query, or a fragment. Origins are normalized,
deduplicated, and compared exactly, including the scheme and any non-default
port. List every application, API, WebSocket bootstrap, and asset origin the
browser genuinely needs; a parent domain does not authorize its subdomains.

Non-production environments may leave either setting empty. An empty browser
allowlist allows browser-internal documents but no external HTTP(S) origin.

## Browser request enforcement

The request policy is installed on the Playwright `BrowserContext` before its
first page is created. Service workers are disabled for the context. Every
intercepted request is checked, including top-level documents, iframes,
subresources, WebSocket connections, popup pages, and every redirect target.
For WebSockets, `ws` maps to the corresponding allowed `http` origin and `wss`
maps to `https`, with the same host and port. Allowing the first URL in a
redirect chain does not allow a later target, and allowing a document does not
implicitly allow its scripts, images, or API requests.

`about:blank`, `about:srcdoc`, and `data:` are permitted only as internal
browser documents. A `blob:` URL is permitted only when its embedded origin is
in the configured allowlist. Any HTTP(S) request initiated from those documents
is still intercepted and evaluated independently. Other schemes and HTTP(S)
URLs containing credentials are rejected.

The browser allowlist does not govern arbitrary commands such as `curl`, package
managers, or Git. Those processes are directed through the proxy, while the
NetworkPolicy prevents a process from bypassing the proxy simply by removing
its proxy environment variables.

## Authoritative egress-proxy checks

Exact-origin matching compares URL names; it does **not** prevent DNS rebinding
and it is not an IP-address authorization decision. The dedicated egress proxy
is therefore the authoritative outbound control. For every request and every
redirect, the proxy must:

- allow only the explicitly approved destination policy;
- resolve the destination itself and validate every returned address;
- reject loopback, RFC1918 private, carrier-grade NAT, link-local, multicast,
  unspecified, and IPv6 unique-local destinations as appropriate for the
  deployment;
- reject cloud metadata addresses and hostnames, including
  `169.254.169.254`; and
- connect only to a validated address, with address pinning or a fresh
  validation that prevents a second resolution from changing the result.

Apply equivalent checks to HTTP `CONNECT` tunnels. The proxy must not trust DNS
answers supplied by the sandbox, and it should log the normalized destination,
decision, resolved address, session correlation identifier, and byte totals
without recording credentials or sensitive payloads.

## Kubernetes enforcement

[`deploy/kubernetes/sandbox-network-policy.yaml`](../deploy/kubernetes/sandbox-network-policy.yaml)
is an adaptation template. It provides:

- a default-deny ingress and egress policy for pods labelled as the sandbox;
- ingress on TCP 4120 only from explicitly labelled sandbox-client pods;
- no DNS egress from the Sandbox; and
- TCP egress only to pods selected as the dedicated proxy on port 3128.

NetworkPolicy is effective only with an enforcing CNI. Restrict RBAC so
untrusted workloads cannot add the sandbox-client or egress-proxy labels to
themselves. Give the proxy a separate policy and identity; do not label it as a
sandbox pod. If a hostname must be used for the proxy, allow DNS only to a
dedicated non-forwarding resolver that can answer that one service name; never
restore general CoreDNS access, because arbitrary DNS queries form an outbound
data channel that bypasses the HTTP proxy policy.

The example pod template disables service-account token mounting, runs as a
non-root UID, drops all Linux capabilities, forbids privilege escalation, and
makes the image root filesystem read-only. Only bounded `emptyDir` mounts are
writable. Nested `bwrap` needs unprivileged namespace syscalls and permission to
mount its own fresh `/proc`; stock OCI `RuntimeDefault` seccomp and masked system
paths block those operations, while common Ubuntu AppArmor defaults deny mounts.
The template therefore fails closed onto a named `RuntimeClass` and labelled,
tainted Sandbox node pool, enables the pod user namespace with `hostUsers:
false`, selects node-installed `Localhost` seccomp and AppArmor profiles on the
Sandbox container only, and declares `procMount: Unmasked`. It still uses a
non-root UID, `allowPrivilegeEscalation: false`, and an empty capability set.
The referenced profiles and RuntimeClass are intentional provisioning
prerequisites, not files that an application Deployment may install itself.
Start the seccomp policy from the runtime default and add only the namespace
operations required by the pinned bubblewrap version; make the AppArmor policy
equally narrow and verify both on every supported kernel/runtime.
Treat SELinux-only nodes as a separate supported-platform profile: provide and
test an equivalent SELinux policy or declare that node class unsupported; do
not silently drop mandatory-access control from this template.

The reference `hostUsers: false` profile targets Kubernetes 1.36 or newer,
Linux 6.3 or newer with idmapped-mount support on every pod volume, and a CRI /
OCI pair that supports pod user namespaces: containerd 2.0+ or CRI-O 1.25+ with
runc 1.2+ or crun 1.9+ (crun 1.13+ preferred). Kubernetes 1.31+ is also required
for the stable `securityContext.appArmorProfile` field and is therefore already
covered by the 1.36 floor. Treat an unknown field, disabled user-namespace
support, unsupported filesystem, or missing Localhost profile as an unsupported
platform that must fail deployment, not as a reason to delete the boundary.

On the required Kubernetes 1.36+ profile, `hostUsers: false` relaxes Baseline
validation for `procMount`, but Restricted still permits only the default/empty
value. Run this workload in a dedicated namespace with an explicitly reviewed
Baseline admission policy and deny other workloads access to that namespace,
RuntimeClass, node label, and toleration. Older Kubernetes releases are outside
this reference contract; do not silently add a broad admission exception or
relax a shared application namespace.

For Docker-based validation, the corresponding non-privileged runtime contract
is `--cap-drop ALL --security-opt no-new-privileges --security-opt
seccomp=unconfined --security-opt systempaths=unconfined --security-opt
apparmor=unconfined`. These unconfined switches make CI a behavioral image gate,
not the production MAC policy; production uses the reviewed Localhost profiles
above. Do not replace the contract with `--privileged` or `--cap-add SYS_ADMIN`.
Pin the real image by digest and verify this exact contract on every target
kernel/runtime. Keep
`QASEY_SANDBOX_MAX_SESSIONS=1`; increase Deployment replicas instead of
co-locating mutually untrusted sessions in one pod.

CPU, memory, and ephemeral-storage requests and limits must be sized from load
tests. Keep `emptyDir.sizeLimit` below the pod's ephemeral-storage limit and
monitor eviction pressure. Kubernetes has no standard per-container PID
resource field; configure kubelet `podPidsLimit` (and enforce the chosen value
through cluster admission/runtime policy). Use an encrypted, quota-controlled
persistent volume instead of `emptyDir` only when sandbox durability is an
explicit requirement.

## Deployment verification

Before promotion, verify all of the following in a disposable namespace:

1. the sandbox fails to start when either production variable is missing or
   malformed, when isolation is not `bwrap`, or when the shared desktop backend
   is enabled;
2. a real Code Task cannot observe host/sibling files or control-plane secrets,
   can write only its workspace, and is terminated at its hard deadline;
3. an allowed browser page loads while a disallowed redirect and disallowed
   subresource fail;
4. direct TCP egress from the sandbox pod fails even after proxy variables are
   unset, while egress through the proxy succeeds;
5. UDP/TCP DNS from the sandbox pod fails, while the proxy itself can resolve
   approved destinations;
6. the proxy rejects private, link-local, and metadata destinations after DNS
   resolution; and
7. the sandbox API is unreachable from an unlabelled pod.

Treat proxy policy changes, browser origin changes, proxy Service IP changes,
and NetworkPolicy changes as security-sensitive production changes with review
and rollback plans.
