// One turn of a conversation, from its prompt to its end (docs/ARCHITECTURE.md, "Backend" → "Console"): what the
// translation of the CLI's lines remembers between them. Used only under the conversation's lock.
using System.Text.Json;

namespace Claushh.Api.Claude;

// A question waiting for the browser: the CLI's own request id, the tool and its input (passed back unchanged on
// allow), and the one rule allow-always saves (null: no "tak, zawsze").
internal sealed record PendingPermission(string CliRequestId, string ToolName, JsonElement Input, JsonElement? Rule, string? AlwaysRule);

internal sealed class Turn(string directory)
{
    // The conversation's real directory: steps and questions show paths relative to it.
    public string Directory { get; } = directory;
    // tool_use blocks by id, until their result (or a refusal) arrives.
    public Dictionary<string, (string Name, JsonElement Input)> Tools { get; } = new(StringComparer.Ordinal);
    // The message being streamed; a text block's messageId is "<id>:<block index>".
    public string MessageId { get; set; } = "";
    // Open questions by the server's requestId.
    public Dictionary<string, PendingPermission> Pending { get; } = new(StringComparer.Ordinal);
    public bool Interrupting { get; set; }
    // A command ran in this turn, and the repository's status at the prompt (null outside a repository): at the end the
    // paths whose status changed are reported.
    public bool RanCommand { get; set; }
    public Dictionary<string, string>? Before { get; set; }
}
