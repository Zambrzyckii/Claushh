// A conversation in memory (docs/ARCHITECTURE.md, "Backend" → "Console"). Every change of it and every event it sends
// happen under Lock.
using System.Text;

namespace Claushh.Api.Claude;

internal sealed class ConversationState(Guid id, string projectPath, bool resumable)
{
    public Guid Id { get; } = id;
    public string Key { get; } = id.ToString("D");
    public string ProjectPath { get; } = projectPath;
    public SemaphoreSlim Lock { get; } = new(1, 1);
    // The CLI knows this id as a session: the next process starts with --resume.
    public bool Resumable { get; set; } = resumable;
    // null until it is read from the database.
    public int? NextSeq { get; set; }
    // The text deltas of one messageId so far, stored as one row before the next other event.
    public (string MessageId, StringBuilder Text)? OpenText { get; set; }
    // The real path of the project directory at the last launch.
    public string WorkingDirectory { get; set; } = "";
    public ClaudeProcess? Process { get; set; }
    // A launch holds a slot of the limit and has no process yet.
    public bool Launching { get; set; }
    // A process being closed (idle, the limit, an interrupt that timed out); the next launch waits for it.
    public Task Closing { get; set; } = Task.CompletedTask;
    // From an accepted prompt to the end of its turn.
    public bool Busy { get; set; }
    public Turn? Turn { get; set; }
    public DateTimeOffset LastUsed { get; set; }
    // Dropped from Conversations' memory by the idle check; a caller that still holds it looks the conversation up again.
    public bool Forgotten { get; set; }
}
