// The open file a prompt names (web/src/app/core/realtime/console-protocol.ts; docs/ARCHITECTURE.md, "Console"): its
// path and, for a selection, its lines. The CLI gets a note with the path only, never the file's content (decisions:
// docs/PLAN.md, "Backend decisions (stage 3)").
namespace Claushh.Api.Claude;

public sealed record PromptFile(string? Path, int? StartLine, int? EndLine)
{
    public const int MaxLine = 10_000_000;
    private const string Maybe = "This may or may not be related to the current task.";

    // The shape: a path without control characters or line separators (C0, DEL, C1, U+2028, U+2029), so the note's
    // sentence cannot be broken out of, and either both lines (1 ≤ start ≤ end ≤ 10,000,000) or neither.
    public bool IsValid() =>
        Path is { } path && !path.Any(c => char.IsControl(c) || c is '\u2028' or '\u2029')
        && (StartLine, EndLine) switch
        {
            (null, null) => true,
            ({ } start, { } end) => start >= 1 && start <= end && end <= MaxLine,
            _ => false,
        };

    // The note for the CLI, with Path relative to the conversation's directory.
    public string Note() => (StartLine, EndLine) switch
    {
        ({ } start, { } end) when start == end => $"The user selected line {start} of {Path} in the editor. {Maybe}",
        ({ } start, { } end) => $"The user selected lines {start} to {end} of {Path} in the editor. {Maybe}",
        _ => $"The user opened the file {Path} in the editor. {Maybe}",
    };
}
