# Long tasks hide queued messages

Observed on 28 October 2026 with tgfx 0.2.0, fx 0.0.15, Grok 4.7, and Bun 1.4.0
in a local Linux arm64 Docker container.

## Reproduction

1. Run the bot with `--output answer`.
2. Start a task that takes several minutes. In this incident, installing `git`
   and `gh` in a minimal, read-only container led the agent to resolve and unpack
   Debian dependencies into its home directory.
3. Send ordinary follow-up messages while the task is running.
4. Observe a typing indicator, but no acknowledgement of the follow-ups.

## Evidence

The installation request started at 15:13:18 UTC. Follow-up messages arrived at
15:15:32 and 15:17:57; both remained `received` behind the `running` request.
The container was healthy, memory use was about 218 MiB of its 1 GiB limit,
and no permission approval was pending. Agent tool results continued arriving:
this was a long task, not a confirmed deadlock.

The affected fx process was terminated at 15:19:22 UTC to release the queue.
tgfx started the next request at 15:19:23 and delivered its reply at 15:20:44.
The recorded original task lasted just over six minutes before intervention;
the user experienced the bot as unresponsive for roughly ten minutes.

## Cause and fix

Serial execution per chat/topic is intentional. The bug was that queue depth
was visible only in the terminal; Telegram users could not tell whether their
follow-up had arrived or discover how to stop the current task.

The first queued ordinary request now gets a short acknowledgement with
`/stop` (or `/stop@bot` in groups). Additional queued requests do not repeat the
notice until the route drains. Notice delivery is independent of task execution;
a Telegram error is logged without failing the request. Existing control
commands continue to bypass the queue.

Reply styles still apply only to new tasks. Changing `/format` does not alter a
running task, and no elapsed-time limit cancels legitimate long work.

Regression tests use the fake fx process, fake Telegram HTTP server and real
SQLite to verify queue acknowledgement, duplicate suppression, cancellation,
and next-task-only reply styles.

## Separate follow-ups

- Build routine tools into the container image so an agent does not have to
  assemble a package manager during a conversation.
- Consider an explicit status command showing elapsed time, recent activity,
  and queue depth. A typing indicator alone does not distinguish slow work from
  an unresponsive provider or tool.
