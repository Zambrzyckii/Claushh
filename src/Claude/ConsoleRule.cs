// An "always" rule the owner saved for a project with the allow-always answer (docs/ARCHITECTURE.md, "Backend" →
// "Console"), passed back to every launch of the project's console in --settings permissions.allow.
namespace Claushh.Api.Claude;

public sealed class ConsoleRule
{
    public required string ProjectPath { get; set; }
    // In the CLI's own form, e.g. "Bash(git init *)".
    public required string Rule { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}
