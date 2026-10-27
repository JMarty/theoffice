"""Red-first tests for the reply guard (Stop hook for the main agent): an owner Slack message answered with plain text but no office-say gets ONE reminder."""
import io
import json
import os
import tempfile
import unittest

import reply_guard as rg

OWNER = "[Slack message from the owner]  "


def user(text):
    return {"type": "user", "message": {"role": "user", "content": text}}


def tool_result():
    return {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}}


def asst_text(text):
    return {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}


def asst_tool(name, **inp):
    return {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": name, "input": inp}]}}


def say(msg="hello"):
    return asst_tool("Bash", command=f'office-say "{msg}"')


class Evaluate(unittest.TestCase):
    def test_owner_question_answered_in_plain_text_only_is_blocked_once(self):
        r = rg.evaluate([user(OWNER + "Is it done yet?"), asst_text("Yes it is done.")], stop_hook_active=False)
        self.assertEqual(r["decision"], "block")
        self.assertIn("office-say", r["reason"])

    def test_an_office_say_after_the_message_means_answered(self):
        e = [user(OWNER + "Is it done yet?"), asst_tool("Bash", command="curl x"), tool_result(), say("done"), tool_result(), asst_text("sent")]
        self.assertEqual(rg.evaluate(e, False)["decision"], "allow")

    def test_office_say_heredoc_form_and_slack_tools_also_count(self):
        for cmd in ("office-say <<'EOF'\nhi\nEOF", "cd /x && office-say 'a'"):
            self.assertEqual(rg.evaluate([user(OWNER + "status?"), asst_tool("Bash", command=cmd)], False)["decision"], "allow", cmd)
        self.assertEqual(rg.evaluate([user(OWNER + "status?"), asst_tool("mcp__claude_ai_Slack__slack_send_message", text="x")], False)["decision"], "allow")

    def test_file_uploads_to_slack_count_as_a_reply(self):
        for cmd in ("python3 upload.py --slack-file-send report.pdf", "curl -F file=@a.pdf https://slack.com/api/files.completeUploadExternal", "curl https://slack.com/api/chat.postMessage -d x"):
            self.assertEqual(rg.evaluate([user(OWNER + "send me the pdf?"), asst_tool("Bash", command=cmd)], False)["decision"], "allow", cmd)

    def test_stop_hook_active_never_blocks_again(self):
        self.assertEqual(rg.evaluate([user(OWNER + "status?"), asst_text("x")], stop_hook_active=True)["decision"], "allow")

    def test_closers_need_no_reply(self):
        for t in ("ok", "thanks!", "👍", "got it"):
            self.assertEqual(rg.evaluate([user(OWNER + t), asst_text("noted")], False)["decision"], "allow", t)

    def test_a_question_mark_is_never_a_closer(self):
        self.assertEqual(rg.evaluate([user(OWNER + "ok?"), asst_text("yes")], False)["decision"], "block")

    def test_scheduled_heartbeat_task_bus_and_notification_turns_are_skipped(self):
        for p in ("[Scheduled heartbeat: x] Silent check", "[Scheduled task: y] Run this now", '[Inter-agent message from Toby (agent id "toby")] hi', "<task-notification> <task-id>1</task-id>"):
            self.assertEqual(rg.evaluate([user(p), asst_text("done")], False)["decision"], "allow", p)

    def test_a_reply_to_an_EARLIER_owner_message_does_not_cover_a_later_one(self):
        e = [user(OWNER + "first?"), say("answer"), user(OWNER + "second?"), asst_text("plain text only")]
        self.assertEqual(rg.evaluate(e, False)["decision"], "block")

    def test_image_note_after_the_owner_message_does_not_hide_it(self):
        e = [user(OWNER + "what is this?"), user("[Image: original 100x100, displayed at 100x100]"), asst_text("a cat")]
        self.assertEqual(rg.evaluate(e, False)["decision"], "block")

    def test_a_skill_loaded_mid_turn_does_not_hide_the_owner_message(self):
        e = [user(OWNER + "do the thing?"), asst_tool("Skill", skill="x"), user("Base directory for this skill: /home/x/.claude/skills/x\n\n# X"), asst_text("done")]
        self.assertEqual(rg.evaluate(e, False)["decision"], "block")

    def test_tool_results_are_not_prompts(self):
        e = [user(OWNER + "do it"), asst_tool("Bash", command="ls"), tool_result(), asst_text("listed")]
        self.assertEqual(rg.evaluate(e, False)["decision"], "block")

    def test_no_owner_message_at_all_allows(self):
        self.assertEqual(rg.evaluate([asst_text("x")], False)["decision"], "allow")
        self.assertEqual(rg.evaluate([], False)["decision"], "allow")


class Hook(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.tp = os.path.join(self.d, "t.jsonl")
        with open(self.tp, "w") as f:
            for e in [user(OWNER + "status?"), asst_text("fine")]:
                f.write(json.dumps(e) + "\n")

    def run_hook(self, agent="marveen", mode="enforce", active=False, path=None):
        out = io.StringIO()
        payload = {"transcript_path": path or self.tp, "stop_hook_active": active, "hook_event_name": "Stop"}
        rc = rg.hook_main(io.StringIO(json.dumps(payload)), out, env={"OFFICE_AGENT_ID": agent}, store=self.d, mode=mode)
        return rc, out.getvalue()

    def test_enforce_blocks_for_the_main_agent_with_a_stop_decision(self):
        rc, out = self.run_hook()
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out)["decision"], "block")

    def test_other_agents_are_never_touched(self):
        self.assertEqual(self.run_hook(agent="toby"), (0, ""))
        self.assertEqual(self.run_hook(agent=""), (0, ""))

    def test_log_mode_records_but_does_not_block(self):
        self.assertEqual(self.run_hook(mode="log"), (0, ""))
        rec = json.loads(open(os.path.join(self.d, "reply-guard.log.jsonl")).read().strip().splitlines()[-1])
        self.assertEqual(rec["would"], "block")
        self.assertNotIn("status?", json.dumps(rec))

    def test_while_the_fleet_is_frozen_the_guard_always_allows(self):
        open(os.path.join(self.d, "fleet-freeze.json"), "w").write("{}")
        self.assertEqual(self.run_hook(), (0, ""))
        self.assertEqual(self.run_hook(mode="log"), (0, ""))
        self.assertFalse(os.path.exists(os.path.join(self.d, "reply-guard.log.jsonl")))  # not even logged as a would-block
        os.remove(os.path.join(self.d, "fleet-freeze.json"))
        self.assertEqual(json.loads(self.run_hook()[1])["decision"], "block")  # thawed: guards again

    def test_second_stop_in_the_same_turn_passes(self):
        self.assertEqual(self.run_hook(active=True), (0, ""))

    def test_missing_or_garbled_transcript_fails_open(self):
        self.assertEqual(self.run_hook(path="/nonexistent"), (0, ""))
        open(self.tp, "w").write("{{{ not jsonl\n")
        self.assertEqual(self.run_hook(), (0, ""))

    def test_mode_defaults_to_log(self):
        self.assertEqual(rg.read_mode(self.d), "log")
        open(os.path.join(self.d, "reply-guard.mode"), "w").write("enforce")
        self.assertEqual(rg.read_mode(self.d), "enforce")


class Replay(unittest.TestCase):
    def test_replay_counts_owner_turns_and_what_the_guard_would_have_done(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "s.jsonl")
        entries = [user(OWNER + "a?"), say("x"), user(OWNER + "b?"), asst_text("plain"), user(OWNER + "thanks"), asst_text("np"), user("[Scheduled heartbeat: h] x"), asst_text("quiet")]
        with open(p, "w") as f:
            for e in entries:
                f.write(json.dumps(e) + "\n")
        r = rg.replay([p])
        self.assertEqual(r["owner_turns"], 3)
        self.assertEqual(r["answered"], 1)
        self.assertEqual(r["closers"], 1)
        self.assertEqual(r["would_block"], 1)



class Install(unittest.TestCase):
    def test_adds_one_stop_hook_idempotently_keeps_others_and_removes_cleanly(self):
        import install_hook as ih
        cur = {"model": "m", "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "other-stop"}]}], "PreToolUse": [{"matcher": "*", "hooks": []}]}}
        once = ih.apply(cur, "/e")
        self.assertEqual(once, ih.apply(once, "/e"))
        self.assertEqual(len(once["hooks"]["Stop"]), 2)
        self.assertIn("/e/tools/reply-guard/reply_guard.py hook", json.dumps(once))
        self.assertIn("sh -c", once["hooks"]["Stop"][1]["hooks"][0]["command"])  # prefilter: non-main agents never start python
        self.assertEqual(once["hooks"]["PreToolUse"], cur["hooks"]["PreToolUse"])
        self.assertEqual(ih.apply(once, "/e", remove=True), cur)


if __name__ == "__main__":
    unittest.main()
