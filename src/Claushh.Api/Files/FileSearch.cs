// Search in files for POST /api/search (docs/ARCHITECTURE.md, "Files and editor" → "Search API contract", "Backend" →
// "Files"; decisions: docs/PLAN.md, "Backend decisions (stage 2)"). In-process: the walk goes through ProjectPaths, never
// enters a directory link, skips node_modules and what git ignores in a repository, reads text as the files API does,
// and matches each line with a regular expression that runs in linear time. Synchronous, so a LibGit2Sharp repository
// stays on one thread. The query is never logged: a pattern or glob .NET refuses is dropped with its exception, whose
// message would quote it.
using System.Diagnostics;
using System.Text.RegularExpressions;
using Claushh.Api.Git;
using Microsoft.Extensions.FileSystemGlobbing;

namespace Claushh.Api.Files;

public sealed record SearchMatch(int Line, int Column, string Preview, int[][] Ranges);

public sealed record SearchFile(string Path, IReadOnlyList<SearchMatch> Matches);

// Limit: null, "results" (a match past SearchLimits.MaxMatches was found) or "time" (past SearchLimits.Time).
public sealed record SearchResult(IReadOnlyList<SearchFile> Files, int MatchCount, string? Limit);

public sealed class FileSearch(ProjectPaths paths, Repositories repositories, SearchLimits limits, ILogger<FileSearch> log)
{
    public const int MaxText = 1_000;
    private const int PreviewBefore = 30;
    private const int PreviewLength = 250;
    private const string NodeModules = "node_modules";
    // Globs are matched in memory against paths under this made-up root; nothing is ever read there.
    private const string GlobRoot = "/search";

    // The query as a regular expression without backtracking, or null for one .NET refuses: a syntax error, or a
    // construct that needs backtracking (lookarounds, backreferences, atomic groups, conditionals, \G).
    public static Regex? Pattern(string query, bool matchCase, bool wholeWord, bool regex)
    {
        var options = RegexOptions.NonBacktracking | RegexOptions.CultureInvariant
            | (matchCase ? RegexOptions.None : RegexOptions.IgnoreCase);
        var source = regex ? query : Regex.Escape(query);
        try
        {
            // The pattern must be valid on its own, not only inside the whole-word group.
            var pattern = new Regex(source, options);
            return wholeWord ? new Regex($@"\b(?:{source})\b", options) : pattern;
        }
        catch (Exception e) when (e is ArgumentException or NotSupportedException)
        {
            return null;
        }
    }

    // Comma-separated globs relative to the search root: "*" stays within a name, "**" is any depth, and a glob without
    // "/" matches a name at any depth, as a file or a directory. Case-sensitive, as paths on Linux. Matcher is null
    // without a glob; Valid is false for one the matcher refuses (".." after the start).
    public static (Matcher? Matcher, bool Valid) Globs(string? text)
    {
        Matcher? matcher = null;
        try
        {
            foreach (var part in (text ?? "").Split(','))
            {
                var glob = part.Trim().Trim('/');
                glob = glob.StartsWith("./", StringComparison.Ordinal) ? glob[2..] : glob;
                if (glob.Length == 0)
                {
                    continue;
                }
                var path = glob.Contains('/') ? glob : $"**/{glob}";
                matcher ??= new Matcher(StringComparison.Ordinal);
                matcher.AddInclude(path).AddInclude($"{path}/**/*");
            }
            // One match, so a pattern the matcher builds lazily fails here and not during the walk.
            _ = matcher?.Match(GlobRoot, "x");
            return (matcher, true);
        }
        catch (ArgumentException)
        {
            return (null, false);
        }
    }

    public SearchResult Run(ProjectPath root, Regex pattern, Matcher? include, Matcher? exclude, CancellationToken aborted)
    {
        var run = new SearchRun(paths, repositories, limits, root, pattern, include, exclude, aborted);
        var parts = root.Relative.Split('/');
        // A root inside a repository takes its rules; repositories below the root are found on the way.
        using (var ignores = parts.Length >= 2 && repositories.Find($"{parts[0]}/{parts[1]}") is { Kind: PathKind.Directory } repo
                   ? repositories.Ignores(repo)
                   : null)
        {
            run.Walk(root, ignores);
        }
        if (log.IsEnabled(LogLevel.Debug))
        {
            log.LogDebug("Search in files: {Files} files read in {Milliseconds} ms, limit {Limit}",
                run.FilesRead, (long)run.Elapsed.TotalMilliseconds, run.Limit ?? "none");
        }
        return new SearchResult(run.Files, run.MatchCount, run.Limit);
    }

    // One search: its walk, its counts and when it stops.
    private sealed class SearchRun(ProjectPaths paths, Repositories repositories, SearchLimits limits, ProjectPath root,
        Regex pattern, Matcher? include, Matcher? exclude, CancellationToken aborted)
    {
        private readonly long _started = Stopwatch.GetTimestamp();

        public List<SearchFile> Files { get; } = [];
        public int MatchCount { get; private set; }
        public int FilesRead { get; private set; }
        public string? Limit { get; private set; }
        public TimeSpan Elapsed => Stopwatch.GetElapsedTime(_started);

        // The entries of a directory by name. A directory whose real path is not <directory>/<name> is a link and is
        // never entered, so the walk cannot loop or leave the tree it was given.
        public void Walk(ProjectPath directory, IgnoreRules? ignores)
        {
            List<ProjectPath> entries;
            try
            {
                entries = [.. paths.List(directory).OrderBy(entry => entry.Relative, StringComparer.Ordinal)];
            }
            catch (DirectoryNotFoundException)
            {
                return; // gone while the search ran
            }
            foreach (var entry in entries)
            {
                if (Stopped())
                {
                    return;
                }
                var name = Path.GetFileName(entry.Relative);
                if (entry.Kind == PathKind.File)
                {
                    if (Included(entry) && ignores?.IsIgnored(entry.Relative, directory: false) != true)
                    {
                        SearchIn(entry);
                    }
                }
                else if (name != NodeModules && entry.FullPath == Path.Join(directory.FullPath, name)
                         && ignores?.IsIgnored(entry.Relative, directory: true) != true)
                {
                    // A repository directly in a workspace brings its own rules.
                    if (entry.Relative.Split('/').Length == 2 && repositories.Find(entry.Relative) is { Kind: PathKind.Directory } repo)
                    {
                        using var own = repositories.Ignores(repo);
                        Walk(entry, own);
                    }
                    else
                    {
                        Walk(entry, ignores);
                    }
                }
            }
        }

        // Checked between files and between lines: a limit reached, the deadline (real time from the search's start), or
        // a client that has gone.
        private bool Stopped()
        {
            if (Limit is null && Elapsed >= limits.Time)
            {
                Limit = "time";
            }
            return Limit is not null || aborted.IsCancellationRequested;
        }

        // The globs see the path relative to the search root.
        private bool Included(ProjectPath file)
        {
            var relative = root.Relative.Length == 0 ? file.Relative : file.Relative[(root.Relative.Length + 1)..];
            return (include is null || include.Match(GlobRoot, relative).HasMatches)
                && (exclude is null || !exclude.Match(GlobRoot, relative).HasMatches);
        }

        // Measured first (over the limit: skipped), read whole, decoded as the files API does (binary: skipped), then
        // matched line by line; "\r" before a line's "\n" is not part of the line.
        private void SearchIn(ProjectPath file)
        {
            string? text;
            try
            {
                if (new FileInfo(file.FullPath).Length > SearchLimits.MaxFileBytes)
                {
                    return;
                }
                var bytes = File.ReadAllBytes(file.FullPath);
                FilesRead++;
                // It may have grown since it was measured.
                text = bytes.Length > SearchLimits.MaxFileBytes ? null : FileStore.DecodeText(bytes);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                return; // gone or unreadable while the search ran
            }
            if (text is null)
            {
                return;
            }
            var matches = new List<SearchMatch>();
            var rest = text.AsSpan();
            for (var number = 1; !Stopped(); number++)
            {
                var end = rest.IndexOf('\n');
                var line = end < 0 ? rest : rest[..end];
                if (line.Length > 0 && line[^1] == '\r')
                {
                    line = line[..^1];
                }
                if (MatchLine(line, number) is { } match)
                {
                    matches.Add(match);
                }
                if (end < 0)
                {
                    break;
                }
                rest = rest[(end + 1)..];
            }
            if (matches.Count > 0)
            {
                Files.Add(new SearchFile(file.Relative, matches));
            }
        }

        // The line's entry, or null without a match. An empty match marks nothing and is not counted. The preview starts
        // at most 30 characters before the first match, without leading whitespace or half a character, and has at most
        // 250 characters; the ranges are clipped to it.
        private SearchMatch? MatchLine(ReadOnlySpan<char> line, int number)
        {
            List<(int Index, int Length)> found = [];
            foreach (var match in pattern.EnumerateMatches(line))
            {
                if (match.Length == 0)
                {
                    continue;
                }
                if (MatchCount == SearchLimits.MaxMatches)
                {
                    Limit = "results";
                    break;
                }
                found.Add((match.Index, match.Length));
                MatchCount++;
            }
            if (found.Count == 0)
            {
                return null;
            }
            var first = found[0].Index;
            var cut = Math.Max(0, first - PreviewBefore);
            while (cut < first && char.IsWhiteSpace(line[cut]))
            {
                cut++;
            }
            if (cut < first && char.IsLowSurrogate(line[cut]))
            {
                cut++;
            }
            var length = Math.Min(PreviewLength, line.Length - cut);
            if (length > 0 && cut + length < line.Length && char.IsHighSurrogate(line[cut + length - 1]))
            {
                length--;
            }
            var ranges = found
                .Select(match => new[] { Math.Max(0, match.Index - cut), Math.Min(length, match.Index + match.Length - cut) })
                .Where(range => range[0] < range[1])
                .ToArray();
            return new SearchMatch(number, first + 1, line.Slice(cut, length).ToString(), ranges);
        }
    }
}
