// What the console tells about files (docs/ARCHITECTURE.md, "Backend" → "Console"; decisions: docs/PLAN.md, "Backend
// decisions (stage 3)"): an edit's counts from the CLI's own diff, the files an edit or a command changed relative to
// the projects directory, and the cap on a step's output.
using System.Text.Json;
using Claushh.Api.Files;
using Claushh.Api.Git;

namespace Claushh.Api.Claude;

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

    // The repository's status (path → state) when the project is a repository; null otherwise.
    public static Dictionary<string, string>? Status(Repositories repositories, string projectPath)
    {
        try
        {
            if (repositories.Find(projectPath) is not { Kind: PathKind.Directory } repo || repositories.Status(repo) is not { } repoStatus)
            {
                return null;
            }
            var status = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var file in repoStatus.Files)
            {
                status[file.Path] = file.Status;
            }
            return status;
        }
        catch (Exception e) when (e is LibGit2Sharp.LibGit2SharpException or IOException)
        {
            return null;
        }
    }

    // The paths whose status differs between the prompt and now (new, gone or changed), in order.
    public static List<string> Changed(Dictionary<string, string> before, Dictionary<string, string>? after)
    {
        if (after is null)
        {
            return [];
        }
        return [.. after.Keys.Union(before.Keys)
            .Where(path => !before.TryGetValue(path, out var was) || !after.TryGetValue(path, out var now) || was != now)
            .Order(StringComparer.Ordinal)];
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
