// A console conversation and its event log (docs/ARCHITECTURE.md, "Backend" → "Console"): the events exactly as they
// were sent, in order, for replay; the CLI keeps the model's own memory for --resume.
namespace Claushh.Api.Claude;

public sealed class Conversation
{
    public Guid Id { get; set; }
    // As the client sent it, relative to the projects directory.
    public required string ProjectPath { get; set; }
    public DateTimeOffset StartedAt { get; set; }
    // Retention counts from here.
    public DateTimeOffset LastEventAt { get; set; }
    // The CLI has reported this id as its session (system/init), so the next process starts with --resume.
    public bool Resumable { get; set; }
}

public sealed class ConversationEvent
{
    public Guid ConversationId { get; set; }
    public int Seq { get; set; }
    // The event's JSON as it was sent: text, not jsonb, so a replay is the same JSON.
    public required string Json { get; set; }
}
