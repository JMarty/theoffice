#!/usr/bin/env python3
"""agent-msg: send an inter-agent bus message and KNOW whether it went out.

  agent-msg [--from AGENT] [--allow-unknown] TO "message"      (message "-" = read it from stdin)

Retries are SAFE ones only: a POST that may already have been accepted is never repeated (the bus has no idempotency key, a repeat would deliver
the message twice). Retried: connection refused / unreachable (nothing was sent) and HTTP 502/503 (a proxy or the bus was not ready). NOT retried: a read
timeout (the bus may have accepted it: reported as UNKNOWN OUTCOME, exit 2, check the recipient before resending) and any other HTTP error (400/401/500: a
real answer, retrying cannot help). A message that starts with `--` is read as an option: pass it after `--` or via stdin (`agent-msg TO -`).

Why: `curl ... >/dev/null && echo sent` reports success whenever curl completed an HTTP request, even if the bus answered
401/400/500, so a message can be lost while the sender believes it was delivered. Here a message counts as sent ONLY when the bus
answered HTTP 200 with an integer id. The JSON body is built with json.dumps (quotes, newlines, $ and backticks are safe), a failure
is retried up to 3 times, and a final failure exits 1 with "NOT SENT" on stderr and a line in store/agent-msg-failures.log
(timestamp, from, to, status; never the message text or the token). The recipient must be a routable agent id: the bus accepts any
`to` string and answers with an id, so an unknown one is refused unless --allow-unknown.

Env: OFFICE_TENANT_ROOT, OFFICE_PORT (default 3430), OFFICE_AGENT_ID (the sender).
"""
import argparse
import json
import os
import sys
import time
import socket
import urllib.error
import urllib.request

TENANT = os.environ.get("OFFICE_TENANT_ROOT") or os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tenant")
ATTEMPTS = 3


def _log_failure(tenant, sender, to, status):
    try:
        with open(os.path.join(tenant, "store", "agent-msg-failures.log"), "a") as f:
            f.write(f"{time.strftime('%F %T')} from={sender} to={to} last={status}\n")
    except OSError:
        pass


def main(argv, env=os.environ, stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr, sleep=time.sleep):
    ap = argparse.ArgumentParser(prog="agent-msg")
    ap.add_argument("--from", dest="sender")
    ap.add_argument("--allow-unknown", action="store_true")
    ap.add_argument("to")
    ap.add_argument("content")
    a = ap.parse_args(argv)
    tenant = env.get("OFFICE_TENANT_ROOT") or TENANT
    sender = a.sender or env.get("OFFICE_AGENT_ID", "")
    if not sender:
        print("agent-msg: no sender identity (set OFFICE_AGENT_ID or pass --from)", file=stderr)
        return 1
    content = stdin.read() if a.content == "-" else a.content
    base = f"http://127.0.0.1:{env.get('OFFICE_PORT', '3430')}"
    try:
        token = open(os.path.join(tenant, "store", ".dashboard-token")).read().strip()
    except OSError:
        print("agent-msg: NOT SENT (cannot read the dashboard token)", file=stderr)
        _log_failure(tenant, sender, a.to, "no-token")
        return 1
    headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}

    if not a.allow_unknown:
        try:
            req = urllib.request.Request(base + "/api/agents", headers=headers)
            with urllib.request.urlopen(req, timeout=10) as r:
                known = {x.get("id") for x in json.load(r)}
            if a.to not in known:
                print(f"agent-msg: NOT SENT, '{a.to}' is not a registered agent (the bus would accept it and nobody would read it). Known: {', '.join(sorted(k for k in known if k))}", file=stderr)
                return 1
        except (OSError, ValueError):
            pass  # cannot verify the recipient: do not block the send on the check itself

    body = json.dumps({"from": sender, "to": a.to, "content": content}).encode()
    last = "no-attempt"
    for n in range(1, ATTEMPTS + 1):
        retry = False
        try:
            req = urllib.request.Request(base + "/api/messages", data=body, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=15) as r:
                try:
                    payload = json.load(r)
                except ValueError:
                    payload = None
                if r.status == 200 and isinstance(payload, dict) and isinstance(payload.get("id"), int):
                    print(f"sent id={payload['id']} to={a.to}", file=stdout)
                    return 0
                last = f"http {r.status} without an id"  # the bus answered: do not repeat
        except urllib.error.HTTPError as e:
            last = f"http {e.code}"
            retry = e.code in (502, 503)
        except (socket.timeout, TimeoutError):
            print(f"agent-msg: UNKNOWN OUTCOME for {a.to}: the bus did not answer in time and may have accepted the message. NOT retried (that could deliver it twice): check the recipient before resending.", file=stderr)
            _log_failure(tenant, sender, a.to, "timeout-unknown-outcome")
            return 2
        except urllib.error.URLError as e:
            if isinstance(e.reason, (socket.timeout, TimeoutError)):
                print(f"agent-msg: UNKNOWN OUTCOME for {a.to}: the bus did not answer in time and may have accepted the message. NOT retried (that could deliver it twice): check the recipient before resending.", file=stderr)
                _log_failure(tenant, sender, a.to, "timeout-unknown-outcome")
                return 2
            last = f"unreachable {type(e.reason).__name__}"
            retry = True  # connection refused / no route: nothing was sent, safe to repeat
        except OSError as e:
            last = f"error {type(e).__name__}"
            retry = isinstance(e, ConnectionError) and not isinstance(e, (ConnectionResetError, BrokenPipeError, ConnectionAbortedError))
        if not retry:
            break
        if n < ATTEMPTS:
            sleep(n)
    print(f"agent-msg: NOT SENT to {a.to} ({last})", file=stderr)
    _log_failure(tenant, sender, a.to, last)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
