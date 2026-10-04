// The contract's console events (web/src/app/core/realtime/console-protocol.ts; docs/ARCHITECTURE.md, "Console") as JSON
// elements, sent and stored as they are, so a replay is the same JSON as the live stream. Absent optional fields are
// left out.
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Claushh.Api.Claude;

internal static class ConsoleEvents
{
    private static readonly JsonSerializerOptions Options = new() { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };

    public static JsonElement Conversation(string id, string projectPath, DateTimeOffset startedAt) => Of(new
    {
        type = "conversation",
        conversationId = id,
        projectPath,
        startedAt = startedAt.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
    });

    public static JsonElement Prompt(string id, string text) => Of(new { type = "prompt", conversationId = id, text });

    public static JsonElement Step(string id, string stepId, string kind, string target, int? added = null, int? removed = null) =>
        Of(new { type = "step", conversationId = id, stepId, kind, target, added, removed });

    public static JsonElement StepOutput(string id, string stepId, string text, bool isError) =>
        Of(new { type = "step-output", conversationId = id, stepId, text, isError });

    public static JsonElement Text(string id, string messageId, string delta) =>
        Of(new { type = "text", conversationId = id, messageId, delta });

    public static JsonElement Permission(string id, string requestId, string description, string? alwaysRule) =>
        Of(new { type = "permission", conversationId = id, requestId, description, alwaysRule });

    public static JsonElement Resolved(string id, string requestId, string decision) =>
        Of(new { type = "permission-resolved", conversationId = id, requestId, decision });

    public static JsonElement Status(string id, string state, string? message = null) =>
        Of(new { type = "status", conversationId = id, state, message });

    public static JsonElement FilesChanged(string id, IReadOnlyList<string> paths) =>
        Of(new { type = "files-changed", conversationId = id, paths });

    private static JsonElement Of<T>(T value) => JsonSerializer.SerializeToElement(value, Options);
}
