// The options of one prompt (web/src/app/core/realtime/console-protocol.ts): the CLI's own values, given at launch and
// applied again before every prompt.
namespace Claushh.Api.Claude;

public sealed record PromptOptions(string Model, string Effort, string Mode)
{
    public static bool IsValid(string? model, string? effort, string? mode) =>
        model is "opus" or "sonnet" or "haiku" && effort is "low" or "medium" or "high" or "max"
        && mode is "default" or "acceptEdits" or "plan";
}
