// Reading the CLI's stream-json lines (docs/ARCHITECTURE.md, "Backend" → "Console"): only what the event mapping
// needs, tolerant of fields that are missing or of another type.
using System.Text.Json;

namespace Claushh.Api.Claude;

internal static class StreamJson
{
    public static JsonElement? Get(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) ? value : null;

    public static string? Str(JsonElement element, string name) =>
        Get(element, name) is { ValueKind: JsonValueKind.String } value ? value.GetString() : null;

    public static bool True(JsonElement element, string name) => Get(element, name) is { ValueKind: JsonValueKind.True };

    public static IEnumerable<JsonElement> Items(JsonElement? array) =>
        array is { ValueKind: JsonValueKind.Array } items ? (IEnumerable<JsonElement>)items.EnumerateArray() : [];

    // The content blocks of an assistant or user line.
    public static IEnumerable<JsonElement> Content(JsonElement line) =>
        Get(line, "message") is { } message ? Items(Get(message, "content")) : [];

    // Lines of subagents carry their parent's tool_use id; only the conversation's own lines become events.
    public static bool TopLevel(JsonElement line) => Get(line, "parent_tool_use_id") is null or { ValueKind: JsonValueKind.Null };

    // The step kind of a tool; null for a tool without a step (Task*, ToolSearch, ExitPlanMode and any other).
    public static string? Kind(string tool, JsonElement? result) => tool switch
    {
        "Read" => "read",
        "Edit" or "NotebookEdit" => "edit",
        // An update of an existing file is an edit; a new file (or a write that failed) is a write.
        "Write" => result is { } written && Str(written, "type") == "update" ? "edit" : "write",
        "Bash" => "command",
        "Glob" or "Grep" => "search",
        "WebFetch" or "WebSearch" or "Task" => "other",
        _ => null,
    };

    // What a step shows: the whole command, a path relative to the conversation's directory (absolute outside it), the
    // search pattern, the URL, the query, or a subagent's description.
    public static string Target(string tool, JsonElement input, string directory) => tool switch
    {
        "Bash" => Str(input, "command") ?? "",
        "Read" or "Edit" or "Write" => Display(Str(input, "file_path") ?? "", directory),
        "NotebookEdit" => Display(Str(input, "notebook_path") ?? Str(input, "file_path") ?? "", directory),
        "Glob" or "Grep" => Str(input, "pattern") ?? "",
        "WebFetch" => Str(input, "url") ?? "",
        "WebSearch" => Str(input, "query") ?? "",
        "Task" => Str(input, "description") ?? "",
        _ => "",
    };

    public static string Display(string path, string directory) =>
        path.StartsWith(directory + "/", StringComparison.Ordinal) ? path[(directory.Length + 1)..] : path;

    // A tool_result's content as text: a string, or the text blocks of an array.
    public static string ContentText(JsonElement block) => Get(block, "content") switch
    {
        { ValueKind: JsonValueKind.String } text => text.GetString() ?? "",
        { ValueKind: JsonValueKind.Array } items => string.Join("\n", items.EnumerateArray().Select(item => Str(item, "text")).OfType<string>()),
        _ => "",
    };

    // A step's output: a command's stdout, then its stderr when not empty, or the result's text when it failed (then the
    // CLI gives no stdout); other tools show output only on an error.
    public static List<(string Text, bool IsError)> Outputs(string tool, JsonElement block, JsonElement? result)
    {
        var isError = True(block, "is_error");
        var outputs = new List<(string Text, bool IsError)>();
        if (tool == "Bash" && result is { ValueKind: JsonValueKind.Object } structured && Str(structured, "stdout") is { } stdout)
        {
            if (stdout.Length > 0)
            {
                outputs.Add((stdout, isError));
            }
            if (Str(structured, "stderr") is { Length: > 0 } stderr)
            {
                outputs.Add((stderr, isError));
            }
        }
        else if ((tool == "Bash" || isError) && ContentText(block) is { Length: > 0 } text)
        {
            outputs.Add((text, isError));
        }
        return outputs;
    }

    // A tool the CLI did not run (denied, refused, cancelled) has a non_execution_kind for its id.
    public static bool NotExecuted(JsonElement line, string toolUseId) =>
        Items(Get(line, "tool_result_meta")).Any(meta => Str(meta, "id") == toolUseId && Get(meta, "non_execution_kind") is not null);
}
