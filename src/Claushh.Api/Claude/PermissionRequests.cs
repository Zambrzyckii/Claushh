// The console's questions (docs/ARCHITECTURE.md, "Backend" → "Console"; decisions: docs/PLAN.md, "Backend decisions
// (stage 3)"): what a can_use_tool request shows, the one rule "tak, zawsze" may save, and the CLI's answer to each
// decision. The answer is built from the server's own copy of the question, so allow-always saves exactly the rule the
// browser showed.
using System.Text.Json;

namespace Claushh.Api.Claude;

internal static class PermissionRequests
{
    // Exactly what the question is for: the whole command, a path relative to the conversation's directory (absolute
    // outside it), the URL, the plan; never the description the model wrote.
    public static string Description(string tool, JsonElement input, string directory) => tool switch
    {
        "Bash" => StreamJson.Str(input, "command") ?? "",
        "Read" or "Edit" or "Write" or "NotebookEdit" => StreamJson.Target(tool, input, directory),
        "WebFetch" => StreamJson.Str(input, "url") ?? "",
        "ExitPlanMode" => StreamJson.Str(input, "plan") ?? "",
        _ => $"{tool} {(input.ValueKind == JsonValueKind.Undefined ? "{}" : input.GetRawText())}",
    };

    // The suggestion's rule written Tool(ruleContent), only for exactly one addRules suggestion that allows exactly one
    // rule and is not suppressed; otherwise no rule and no "tak, zawsze".
    public static (JsonElement? Rule, string? Text) Rule(JsonElement request)
    {
        if (StreamJson.True(request, "suppress_always_allow_rule"))
        {
            return (null, null);
        }
        var suggestions = StreamJson.Items(StreamJson.Get(request, "permission_suggestions")).ToList();
        if (suggestions is not [var only] || StreamJson.Str(only, "type") != "addRules" || StreamJson.Str(only, "behavior") != "allow")
        {
            return (null, null);
        }
        var rules = StreamJson.Items(StreamJson.Get(only, "rules")).ToList();
        if (rules is not [var rule] || StreamJson.Str(rule, "toolName") is not { Length: > 0 } tool)
        {
            return (null, null);
        }
        return (rule, StreamJson.Str(rule, "ruleContent") is { } content ? $"{tool}({content})" : tool);
    }

    // allow passes the input back unchanged; allow-always adds the one rule for this session only (the server passes it
    // back at every launch); an approved plan switches the mode back to asking before edits; deny gives the model the
    // CLI's own text.
    public static object Answer(PendingPermission pending, string decision)
    {
        if (decision == "deny")
        {
            return new { behavior = "deny", message = "The user denied this action." };
        }
        if (decision == "allow-always" && pending.Rule is { } rule)
        {
            return new
            {
                behavior = "allow",
                updatedInput = pending.Input,
                updatedPermissions = new[] { new { type = "addRules", rules = new[] { rule }, behavior = "allow", destination = "session" } },
            };
        }
        if (pending.ToolName == "ExitPlanMode")
        {
            return new
            {
                behavior = "allow",
                updatedInput = pending.Input,
                updatedPermissions = new[] { new { type = "setMode", mode = "default", destination = "session" } },
            };
        }
        return new { behavior = "allow", updatedInput = pending.Input };
    }
}
