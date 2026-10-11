# Standard opener template — open-grok-voice

Fill in `<YOUR NAME>` once for your deployment, and `<SUBJECT>` per call.
Lead with the RELATIONSHIP, not the technology. Do not say "voice assistant,"
"automated," "AI," or "system" in the opening — that language makes people hear
a robocall and hang up before you have asked anything.

## The opener (paste into every `task`, swap `<SUBJECT>` and `<YOUR NAME>`)

> "Hi, I'm calling on behalf of <YOUR NAME> — I'm their assistant. I just have
> a couple of quick questions about `<SUBJECT>` — is this the right place to
> ask, or should I be calling somewhere else?"

Order: **who you're calling for → that you're their assistant → the ask.**
Use the same opening again after any transfer; whoever picks up next has heard
none of it. Speak naturally — contractions, normal rhythm, brief pauses. Do
not sound scripted.

Every word of it is true: an assistant calling on someone's behalf is exactly
what this is. "Assistant" is the accurate word; "voice assistant" was never
required, only volunteered.

## The one guardrail that does not move

**If asked whether you are a real person — or whether this is a recording, an
AI, or an automated system — tell the truth immediately, plainly, without
hesitation or defensiveness:**

> "No, I'm an AI assistant — <YOUR NAME> uses me to make calls for them. I can
> have them call you back directly if you'd rather speak with them."

Then continue if they're willing, or thank them and end the call if they're
not. **Never deny it. Never dodge. Never change the subject. Never claim to be
<YOUR NAME>.**

Not volunteering it in the first sentence is fine — plenty of human assistants
don't announce their job title either. Denying it when someone asks directly is
a different thing entirely, and that is the line.

## Phone trees and voicemail: PRESS the key, do not say it

The agent has a `send_dtmf` tool and the prompt already tells it to use one.
Nothing needs to be added to a task for menus to work. What you should know as
the operator:

- **Saying a digit does nothing.** On a measured call, the IVR said "for
  operator assistance press zero" and the agent answered, out loud, "I'll press
  zero for operator assistance. Zero." No tone was sent, the menu looped, and
  the call reached nobody while the log recorded it as completed. That is the
  failure the tool fixes.
- **It matters for voicemail too, not just menus.** On another call the agent
  recorded a full message and the system then said "to send your message, press
  five." The message was never sent. Any task that may end in voicemail depends
  on this working.
- **Zero is the escape hatch.** The agent is told that when no menu option fits,
  0 usually reaches an operator. If a specific tree needs something else
  ("press 4 for records"), say so in the task and it will follow that instead.
- **Tones go to the person you called, never to the agent.** They are played on
  leg A.
- **Outbound calls only.** Inbound callers are live humans, so the keypad is
  not offered.

If you want the agent NOT to navigate a tree — leave a message only, say —
write that in the task. The directive is a default, and the task outranks it.

### The one hard rule for task authors

**Never write a task that has the agent key in a Social Security number, date
of birth, account number, card number, PIN, or any other secret.** This is a
rule about what you ask for, because it cannot be enforced anywhere downstream:

- The **callee's** IVR records every keypress it receives. That is what an IVR
  is for. Anything the agent types lands in their system permanently, and no
  change on our side reaches it.
- Our own call recording is dual-channel on the same leg the tones play on, so
  the tones are very likely captured in the archived audio, where DTMF is
  trivially decodable.
- The digits are written to the Worker log in cleartext, deliberately, so an
  operator can see what the agent pressed.

For menu navigation — "press 2", "press 0 for an operator" — none of that
matters, and that is the use this was built for. It only matters if a task
asks for a secret, so do not.

### What an adversarial or broken phone system can do

The digits come from a model that is listening to whoever answered, so the
callee has real influence over what gets pressed. Worth knowing the actual
shape of that:

- **It can** walk the agent into options on **their own** system — a
  through-dial prompt ("press 9 for an outside line"), or a voicemail control
  code, including destructive ones like "press 7 to delete". The agent is
  explicitly taught to press keys to send voicemail, so that instruction is
  in-distribution.
- **It cannot** transfer, conference, or hang up **our** call, and it cannot
  originate a new call on our account. Telnyx does not read the tones we emit
  as call-control input. So this is not a toll-fraud hole in our Telnyx
  account; the exposure is to the callee's systems and to whatever a task told
  the agent to type.
- A call is capped at 25 keypresses total, so a looping menu cannot drive an
  unbounded sequence.

## Boundaries that ride along

- Collect facts. Do not argue, do not press a declined question, do not
  negotiate.
- Volunteer no personal data beyond what the call strictly needs.
- Stay on the one subject. Anything else is "outside what I was asked to call
  about."
- Read identifiers (phone numbers, URLs, addresses) back to confirm before
  hanging up.
- No voicemail messages (the default — write the task differently if you want
  messages left).
