// What the console tells about files (docs/ARCHITECTURE.md, "Backend" → "Console"; decisions: docs/PLAN.md, "Backend
// decisions (stage 3)"): an edit's counts from the CLI's own diff, the files an edit changed relative to the projects
// directory, and the cap on a step's output.
using System.Text.Json;

namespace Claushh.Api.Claude.Translation;

internal static class FileChanges
{
    public const int MaxOutput = 32_000;

    // +/- of an edit: the lines of a created file, or the + and - lines of the patch's hunks ("\ No newline at end of
    // file" counts as neither); null without a structured result.
    public static (int Added, int Removed)? Counts(JsonElement? result)
    {
        if (result is not { ValueKind: JsonValueKind.Object } edit)
        {
            return null;
        }
        if (StreamJson.Str(edit, "type") == "create" && StreamJson.Str(edit, "content") is { } content)
        {
            return (content.Length == 0 ? 0 : content.Count(c => c == '\n') + (content.EndsWith('\n') ? 0 : 1), 0);
        }
        if (StreamJson.Get(edit, "structuredPatch") is not { ValueKind: JsonValueKind.Array } patch)
        {
            return null;
        }
        var lines = patch.EnumerateArray().SelectMany(hunk => StreamJson.Items(StreamJson.Get(hunk, "lines")))
            .Select(line => line.ValueKind == JsonValueKind.String ? line.GetString() ?? "" : "").ToList();
        return (lines.Count(line => line.StartsWith('+')), lines.Count(line => line.StartsWith('-')));
    }

    // A path of the CLI relative to the projects directory; null outside it or inside .git.
    public static string? Relative(string? path, string root)
    {
        if (path is null || !path.StartsWith(root + "/", StringComparison.Ordinal))
        {
            return null;
        }
        var relative = path[(root.Length + 1)..];
        return relative.Split('/').Contains(".git") ? null : relative;
    }

    // Over MaxOutput characters: the end, after a note with the number left out (never splitting a surrogate pair).
    public static string Cap(string text)
    {
        if (text.Length <= MaxOutput)
        {
            return text;
        }
        var start = text.Length - MaxOutput;
        if (char.IsLowSurrogate(text[start]))
        {
            start++;
        }
        return $"⟨{start} {(start == 1 ? "character" : "characters")} omitted⟩\n{text[start..]}";
    }
}
