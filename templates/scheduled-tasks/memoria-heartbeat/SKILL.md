---
name: memoria-heartbeat
description: Every 30 minutes reviews the conversation, saves what matters, and generates skills if there was complex work
---

Review your conversations from the last 30 minutes. Do two things:

## 1. Memory save

If there was an important decision, preference, lesson or anything that will be useful later, save it:

```bash
curl -s -X POST http://localhost:3430/api/memories \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat {{INSTALL_DIR}}/store/.dashboard-token)" \
  -d '{"agent_id":"YOUR_NAME","content":"...","category":"warm","keywords":"..."}'
```

`category` can be: `hot` (active), `warm` (preference/config), `cold` (lesson), `shared` (for other agents too).
Find your `agent_id` in CLAUDE.md or from the working folder name.

## 2. Skill reflection (MANDATORY if there was complex work)

First decide with these 3 questions:

- **A**: Was there a complex task with at least 5 tool calls in the last 30 minutes?
- **B**: Was there an error → recovery (attempt → fail → different approach) that should go into the Pitfalls section of an existing skill?
- **C**: Was there a user correction ("not like that", "not this", "differently") that calls for a skill fix?

**If A or B or C is YES: a skill action is MANDATORY, it cannot be skipped.**

Steps:
1. Check with `ls $HOME/.claude/skills/` whether a covering skill already exists (text search in `.skill-index.md`)
2. If there is a relevant skill: PATCH it (replace only the changed part, not the whole file).
   - Prefer the `## Pitfalls` section if there was an error/recovery.
   - Use the `## Procedure` section if the process changed.
3. If there is NO relevant skill: create a new one:
   ```bash
   mkdir -p $HOME/.claude/skills/<NEV>
   cat > $HOME/.claude/skills/<NEV>/SKILL.md <<EOF
   ---
   name: <NEV>
   description: When to use it, what it does (1-2 sentences). A concrete trigger.
   ---
   # <Title>

   ## When to use
   ...

   ## Procedure
   1. ...

   ## Pitfalls
   - ...

   ## Verification
   - ...
   EOF
   ```
4. Index regen: `bash $HOME/ClaudeClaw/scripts/skill-index.sh`

**If you skipped the skill action although one of A/B/C was YES:** you must write a `hot` tier memory with the content "skip-skill: <specific reason>" so we can see later why. Do not skip it silently.

## 3. Staying quiet

If there is NO complex task / error / correction (A=B=C=NO), and no new information in the 30 minutes:
- Do not save memory unnecessarily
- Do not generate a skill
- Do not send a message to the channel
- Stay quiet (a short "quiet heartbeat" line in the transcript is enough)
