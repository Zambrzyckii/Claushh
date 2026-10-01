// The git API for the explorer's badges, the status bar, the diff view and Pull / Push (docs/ARCHITECTURE.md,
// "Workspaces and git" → "API contract").
using Claushh.Api.Files;
using Microsoft.Extensions.Options;

namespace Claushh.Api.Git;

public static class GitEndpoints
{
    public sealed record ShowResponse(string Content);
    public sealed record MessageResponse(string Message);
    public sealed record PullResponse(string Message, IReadOnlyList<string> ChangedPaths);

    public static RouteGroupBuilder MapGitEndpoints(this RouteGroupBuilder api)
    {
        var git = api.MapGroup("/git");
        git.MapGet("/status", Status);
        git.MapGet("/show", Show);
        git.MapPost("/pull", Pull);
        git.MapPost("/push", Push);
        return api;
    }

    private static IResult Status(string? repo, Repositories repositories)
    {
        if (repositories.Find(repo) is not { } repository)
        {
            return Results.BadRequest();
        }
        return repository.Kind == PathKind.Directory ? Results.Ok(repositories.Status(repository)) : Results.NotFound();
    }

    // `path` must be a valid path inside `repo`; it is looked up in HEAD, so a file deleted on disk still has content.
    private static IResult Show(string? repo, string? path, Repositories repositories, ProjectPaths paths)
    {
        if (repositories.Find(repo) is not { } repository || path is null
            || !path.StartsWith(repository.Relative + "/", StringComparison.Ordinal) || paths.Resolve(path) is null)
        {
            return Results.BadRequest();
        }
        if (repository.Kind != PathKind.Directory)
        {
            return Results.NotFound();
        }
        var result = repositories.Show(repository, path);
        return result.Status switch
        {
            ShowStatus.Ok => Results.Ok(new ShowResponse(result.Content)),
            ShowStatus.TooLarge => Results.StatusCode(StatusCodes.Status413PayloadTooLarge),
            ShowStatus.NotText => Results.StatusCode(StatusCodes.Status415UnsupportedMediaType),
            _ => Results.NotFound(),
        };
    }

    // `git pull --ff-only` as its two steps, so that the answer follows the step that failed: the fetch (502), then a
    // fast-forward merge (409). The lock and every step share one Git:NetworkTimeout.
    private static async Task<IResult> Pull(string? repo, HttpContext http, Repositories repositories, RepoLocks locks,
        GitRunner git, IOptionsMonitor<GitOptions> options)
    {
        if (repositories.Find(repo) is not { } repository)
        {
            return Results.BadRequest();
        }
        if (repository.Kind != PathKind.Directory)
        {
            return Results.NotFound();
        }
        using var deadline = new GitDeadline(options.CurrentValue.NetworkTimeout, http.RequestAborted);
        try
        {
            using var held = await locks.EnterAsync(repository.FullPath, deadline);
            var before = repositories.Head(repository);
            if (before is not { Upstream: not null, Remote: { } remote })
            {
                return Results.BadRequest(new MessageResponse("Gałąź nie ma gałęzi zdalnej."));
            }
            var fetch = await git.RunAsync(repository.FullPath, ["fetch", remote], deadline);
            if (!fetch.Succeeded)
            {
                return RemoteError(Redacted(fetch.Message, repository));
            }
            var behind = repositories.Head(repository).Behind;
            if (behind == 0)
            {
                return Results.Ok(new PullResponse("Już aktualne.", []));
            }
            var merge = await git.RunAsync(repository.FullPath, ["merge", "--ff-only", "@{upstream}"], deadline, GitRunner.LocalStepLimit);
            if (!merge.Succeeded)
            {
                return Results.Conflict(new MessageResponse(Redacted(merge.Message, repository)));
            }
            // Both paths of a rename (--no-renames); on a branch that had no commits, every file of the new HEAD.
            string[] listing = before.Sha is { } old
                ? ["diff", "--name-only", "--no-renames", "-z", old, "HEAD"]
                : ["ls-tree", "-r", "--name-only", "-z", "HEAD"];
            var changed = await git.RunAsync(repository.FullPath, listing, deadline, GitRunner.LocalStepLimit);
            IReadOnlyList<string> paths = changed.Succeeded
                ? changed.Output.Split('\0', StringSplitOptions.RemoveEmptyEntries).Select(path => $"{repository.Relative}/{path}").ToList()
                : [];
            return Results.Ok(new PullResponse($"Pobrano {behind} {Commits(behind)}.", paths));
        }
        catch (GitTimeoutException e)
        {
            return RemoteError(e.ResponseMessage);
        }
    }

    // To the tracked branch with an explicit refspec, so push.default does not matter; without an upstream, the
    // contract's `git push -u origin HEAD`. A ref refused as [rejected] (the remote has newer commits) is 409; any other
    // failure (network, authentication, [remote rejected] by a hook or a protection rule) is 502.
    private static async Task<IResult> Push(string? repo, HttpContext http, Repositories repositories, RepoLocks locks,
        GitRunner git, IOptionsMonitor<GitOptions> options)
    {
        if (repositories.Find(repo) is not { } repository)
        {
            return Results.BadRequest();
        }
        if (repository.Kind != PathKind.Directory)
        {
            return Results.NotFound();
        }
        using var deadline = new GitDeadline(options.CurrentValue.NetworkTimeout, http.RequestAborted);
        try
        {
            using var held = await locks.EnterAsync(repository.FullPath, deadline);
            var head = repositories.Head(repository);
            if (head.Branch is not { } branch)
            {
                return Results.BadRequest(new MessageResponse("Odłączony HEAD: przełącz się na gałąź, żeby zrobić push."));
            }
            string[] arguments;
            string pushed;
            if (head is { Upstream: { } upstream, Remote: { } remote, MergeRef: { } mergeRef })
            {
                if (head.Ahead == 0)
                {
                    return Results.Ok(new MessageResponse("Nic do wypchnięcia."));
                }
                arguments = ["push", "--porcelain", remote, $"HEAD:{mergeRef}"];
                pushed = $"Wypchnięto {head.Ahead} {Commits(head.Ahead)} do {upstream}.";
            }
            else if (head.HasOrigin)
            {
                arguments = ["push", "--porcelain", "-u", "origin", "HEAD"];
                pushed = $"Wypchnięto gałąź {branch} do origin/{branch}.";
            }
            else
            {
                return Results.BadRequest(new MessageResponse("Brak zdalnego repozytorium 'origin'."));
            }
            var push = await git.RunAsync(repository.FullPath, arguments, deadline);
            // --porcelain: a line per ref, starting with "!" for one that was refused.
            var refused = push.Output.Split('\n').Where(line => line.StartsWith('!')).ToList();
            if (push.Succeeded && refused.Count == 0)
            {
                return Results.Ok(new MessageResponse(pushed));
            }
            var message = Redacted(push.Message, repository);
            return refused.Any(line => line.Contains("\t[rejected]", StringComparison.Ordinal))
                ? Results.Conflict(new MessageResponse(message))
                : RemoteError(message);
        }
        catch (GitTimeoutException e)
        {
            return RemoteError(e.ResponseMessage);
        }
    }

    private static IResult RemoteError(string message) =>
        Results.Json(new MessageResponse(message), statusCode: StatusCodes.Status502BadGateway);

    // git's own messages can repeat the repository's resolved path (e.g. a stale index.lock); the response gets the
    // API path instead, so responses never contain resolved paths.
    private static string Redacted(string message, ProjectPath repository) =>
        message.Replace(repository.FullPath, repository.Relative, StringComparison.Ordinal);

    // Polish plural: 1 commit, 2-4 commity (but 12-14 commitów), otherwise commitów.
    private static string Commits(int count) =>
        count == 1 ? "commit" : count % 10 is >= 2 and <= 4 && count % 100 is < 12 or > 14 ? "commity" : "commitów";
}
