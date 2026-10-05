using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using Claushh.Api.Files;

namespace Claushh.Api.Tests;

public sealed class FileContentTests(ApiFactory api) : ApiTest(api)
{
    private const int MaxBytes = 5 * 1024 * 1024;
    private static readonly byte[] Bom = [0xEF, 0xBB, 0xBF];
    private const UnixFileMode Executable = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;

    public sealed record FileBody(string Path, string Content, string Version);
    public sealed record SavedBody(string Version);
    public sealed record ConflictBody(string CurrentVersion);

    public override async ValueTask InitializeAsync()
    {
        await base.InitializeAsync();
        await Client.LoginAsOwnerAsync();
    }

    [Fact]
    public async Task Reads_the_content_and_its_version()
    {
        var bytes = Encoding.UTF8.GetBytes("int main() {}\n");
        Api.WriteProjectFile("repo/main.c", bytes);

        Assert.Equal(new FileBody("repo/main.c", "int main() {}\n", VersionOf(bytes)), await ReadOkAsync("repo/main.c"));
    }

    [Fact]
    public async Task A_save_returns_the_new_version_and_a_read_shows_the_content()
    {
        Api.WriteProjectFile("repo/main.c", "old\n");
        var before = await ReadOkAsync("repo/main.c");

        var saved = await SaveOkAsync("repo/main.c", "new\n", before.Version);

        Assert.Equal(VersionOf(Encoding.UTF8.GetBytes("new\n")), saved.Version);
        Assert.Equal(new FileBody("repo/main.c", "new\n", saved.Version), await ReadOkAsync("repo/main.c"));
    }

    [Fact]
    public async Task A_bom_is_hidden_from_the_editor_and_kept_on_save_and_line_endings_stay()
    {
        var path = Api.WriteProjectFile("repo/win.txt", [.. Bom, .. Encoding.UTF8.GetBytes("zażółć\r\ngęślą\n")]);
        var file = await ReadOkAsync("repo/win.txt");
        Assert.Equal("zażółć\r\ngęślą\n", file.Content);

        var saved = await SaveOkAsync("repo/win.txt", "jaźń\r\n", file.Version);

        byte[] expected = [.. Bom, .. Encoding.UTF8.GetBytes("jaźń\r\n")];
        Assert.Equal(expected, File.ReadAllBytes(path));
        Assert.Equal(VersionOf(expected), saved.Version);
    }

    [Fact]
    public async Task Files_up_to_5_MB_open_and_larger_ones_are_413()
    {
        Api.WriteProjectFile("big/exact.txt", Enumerable.Repeat((byte)'a', MaxBytes).ToArray());
        Api.WriteProjectFile("big/over.txt", Enumerable.Repeat((byte)'a', MaxBytes + 1).ToArray());

        Assert.Equal(MaxBytes, (await ReadOkAsync("big/exact.txt")).Content.Length);
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, (await ReadAsync("big/over.txt")).StatusCode);
    }

    [Fact]
    public async Task A_nul_byte_or_bytes_that_are_not_utf8_are_415()
    {
        Api.WriteProjectFile("bin/nul.dat", [0x61, 0x00, 0x62]);
        Api.WriteProjectFile("bin/cp1250.txt", [0x7A, 0xB3, 0x6F]); // "zło" in Windows-1250

        Assert.Equal(HttpStatusCode.UnsupportedMediaType, (await ReadAsync("bin/nul.dat")).StatusCode);
        Assert.Equal(HttpStatusCode.UnsupportedMediaType, (await ReadAsync("bin/cp1250.txt")).StatusCode);
    }

    [Fact(Timeout = 30_000)]
    public async Task A_missing_file_a_directory_and_a_fifo_are_404()
    {
        Api.WriteProjectFile("repo/src/main.c", "");
        Api.MakeFifo("repo/pipe");

        // The file next to them opens, so that the 404 of the others is not the answer to everything.
        Assert.Equal(HttpStatusCode.OK,
            (await ReadAsync("repo/src/main.c").WaitAsync(TestContext.Current.CancellationToken)).StatusCode);
        foreach (var path in new[] { "repo/missing.c", "repo/src", "repo/pipe", "" })
        {
            Assert.Equal(HttpStatusCode.NotFound,
                (await ReadAsync(path).WaitAsync(TestContext.Current.CancellationToken)).StatusCode);
        }
    }

    [Fact]
    public async Task Symlinks_inside_work_and_every_way_out_is_400()
    {
        Api.WriteProjectFile("repo/src/app.c", "app\n");
        Api.WriteProjectFile("repo/.git/config", "[core]\n");
        using var outside = new OutsideDirectory();
        File.WriteAllText(outside.Child("secret.txt"), "secret");
        Api.Link("repo/to-app", "src/app.c");
        Api.Link("repo/to-outside", outside.Root);
        Api.Link("repo/to-secret", outside.Child("secret.txt"));
        Api.Link("repo/dangling", Api.ProjectPath("repo/nowhere"));
        Api.Link("repo/loop", Api.ProjectPath("repo/loop"));
        Api.Link("repo/to-git", Api.ProjectPath("repo/.git"));

        Assert.Equal(new FileBody("repo/to-app", "app\n", VersionOf(Encoding.UTF8.GetBytes("app\n"))), await ReadOkAsync("repo/to-app"));
        foreach (var path in new[]
                 {
                     "repo/to-outside/secret.txt", "repo/to-secret", "repo/dangling", "repo/loop", "repo/.git/config",
                     "repo/to-git/config", "../etc/passwd", "/etc/passwd", "repo/./src/app.c", "repo\\src\\app.c",
                 })
        {
            Assert.Equal(HttpStatusCode.BadRequest, (await ReadAsync(path)).StatusCode);
        }
    }

    [Fact]
    public async Task A_change_on_disk_is_409_with_the_current_version_which_then_overwrites()
    {
        var path = Api.WriteProjectFile("repo/main.c", "v1\n");
        var file = await ReadOkAsync("repo/main.c");
        File.WriteAllText(path, "from the console\n");

        var conflict = await SaveAsync("repo/main.c", "mine\n", file.Version);

        Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        var current = (await conflict.Content.ReadFromJsonAsync<ConflictBody>())!.CurrentVersion;
        Assert.Equal(VersionOf(File.ReadAllBytes(path)), current);
        await SaveOkAsync("repo/main.c", "mine\n", current);
        Assert.Equal("mine\n", File.ReadAllText(path));
    }

    [Fact]
    public async Task A_save_keeps_the_file_mode_and_writes_through_a_symlink_without_replacing_it()
    {
        var target = Api.WriteProjectFile("repo/run.sh", "#!/bin/sh\n");
        File.SetUnixFileMode(target, Executable);
        Api.Link("repo/run-link", "run.sh");
        var file = await ReadOkAsync("repo/run-link");

        await SaveOkAsync("repo/run-link", "#!/bin/sh\necho hi\n", file.Version);

        Assert.Equal("#!/bin/sh\necho hi\n", File.ReadAllText(target));
        Assert.Equal(Executable, File.GetUnixFileMode(target));
        Assert.Equal("run.sh", new FileInfo(Api.ProjectPath("repo/run-link")).LinkTarget);
        Assert.Empty(Directory.GetFiles(Api.ProjectPath("repo"), "*claushh*", new EnumerationOptions { AttributesToSkip = 0 }));
    }

    [Fact]
    public async Task A_deleted_file_is_a_conflict_with_absent_and_absent_creates_it_again()
    {
        var path = Api.WriteProjectFile("repo/main.c", "v1\n");
        var file = await ReadOkAsync("repo/main.c");
        File.Delete(path);

        var conflict = await SaveAsync("repo/main.c", "mine\n", file.Version);

        Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        Assert.Equal("absent", (await conflict.Content.ReadFromJsonAsync<ConflictBody>())!.CurrentVersion);
        await SaveOkAsync("repo/main.c", "mine\n", "absent");
        Assert.Equal("mine\n", File.ReadAllText(path));
    }

    [Fact]
    public async Task Absent_is_a_conflict_while_the_file_exists_and_404_in_a_missing_directory()
    {
        var path = Api.WriteProjectFile("repo/main.c", "v1\n");

        var conflict = await SaveAsync("repo/main.c", "mine\n", "absent");

        Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        Assert.Equal(VersionOf(File.ReadAllBytes(path)), (await conflict.Content.ReadFromJsonAsync<ConflictBody>())!.CurrentVersion);
        Assert.Equal(HttpStatusCode.NotFound, (await SaveAsync("repo/missing/new.c", "x", "absent")).StatusCode);
    }

    [Fact(Timeout = 30_000)]
    public async Task Saving_onto_a_directory_a_fifo_or_out_of_the_projects_directory_is_400_and_creates_nothing()
    {
        Api.WriteProjectFile("repo/src/app.c", "");
        Api.MakeFifo("repo/pipe");
        using var outside = new OutsideDirectory();
        Api.Link("repo/to-outside", outside.Root);
        Api.Link("repo/dangling-out", outside.Child("created.txt"));

        foreach (var path in new[] { "repo/src", "repo/pipe", "repo/to-outside/new.txt", "repo/dangling-out", "repo/.git/config", "../new.txt" })
        {
            Assert.Equal(HttpStatusCode.BadRequest,
                (await SaveAsync(path, "x", "absent").WaitAsync(TestContext.Current.CancellationToken)).StatusCode);
        }
        Assert.Empty(Directory.GetFileSystemEntries(outside.Root));
        Assert.False(Directory.Exists(Api.ProjectPath("repo/.git")));
    }

    [Fact]
    public async Task A_save_without_the_xsrf_token_or_with_a_missing_field_is_400_and_changes_nothing()
    {
        var path = Api.WriteProjectFile("repo/main.c", "v1\n");
        var file = await ReadOkAsync("repo/main.c");

        Assert.Equal(HttpStatusCode.BadRequest, (await Client.Http.PutAsJsonAsync(Url("repo/main.c"), new { content = "x" })).StatusCode);
        Client.SendXsrf = false;
        Assert.Equal(HttpStatusCode.BadRequest, (await SaveAsync("repo/main.c", "x", file.Version)).StatusCode);
        Assert.Equal("v1\n", File.ReadAllText(path));
    }

    [Fact]
    public async Task Content_over_5_MB_is_413()
    {
        Api.WriteProjectFile("repo/main.c", "v1\n");
        var file = await ReadOkAsync("repo/main.c");

        Assert.Equal(HttpStatusCode.RequestEntityTooLarge,
            (await SaveAsync("repo/main.c", new string('a', MaxBytes + 1), file.Version)).StatusCode);
    }

    [Fact]
    public async Task Two_saves_with_the_same_base_version_give_one_200_and_one_409()
    {
        var path = Api.WriteProjectFile("repo/main.c", "v1\n");
        var file = await ReadOkAsync("repo/main.c");

        var responses = await Task.WhenAll(
            SaveAsync("repo/main.c", "first\n", file.Version),
            SaveAsync("repo/main.c", "second\n", file.Version));

        Assert.Equal(new[] { HttpStatusCode.OK, HttpStatusCode.Conflict }, responses.Select(r => r.StatusCode).Order());
        Assert.Equal(responses[0].StatusCode == HttpStatusCode.OK ? "first\n" : "second\n", File.ReadAllText(path));
    }

    [Fact]
    public async Task Two_saves_through_a_symlink_and_through_its_target_give_one_200_and_one_409()
    {
        var path = Api.WriteProjectFile("repo/run.sh", "v1\n");
        Api.Link("repo/run-link", "run.sh");
        var file = await ReadOkAsync("repo/run.sh");

        var responses = await Task.WhenAll(
            SaveAsync("repo/run-link", "first\n", file.Version),
            SaveAsync("repo/run.sh", "second\n", file.Version));

        Assert.Equal(new[] { HttpStatusCode.OK, HttpStatusCode.Conflict }, responses.Select(r => r.StatusCode).Order());
        Assert.Equal(responses[0].StatusCode == HttpStatusCode.OK ? "first\n" : "second\n", File.ReadAllText(path));
    }

    [Fact]
    public async Task The_5_MB_limit_of_a_save_counts_the_BOM_that_is_kept()
    {
        var path = Api.WriteProjectFile("repo/win.txt", [.. Bom, (byte)'x']);
        var file = await ReadOkAsync("repo/win.txt");

        var over = await SaveAsync("repo/win.txt", new string('a', FileStore.MaxBytes - 2), file.Version);

        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, over.StatusCode);
        Assert.Equal(file.Version, VersionOf(File.ReadAllBytes(path)));
        await SaveOkAsync("repo/win.txt", new string('a', FileStore.MaxBytes - 3), file.Version);
        Assert.Equal(FileStore.MaxBytes - 3, (await ReadOkAsync("repo/win.txt")).Content.Length);
    }

    [Fact]
    public async Task Content_of_exactly_5_MB_is_saved_and_can_be_read_back()
    {
        Api.WriteProjectFile("repo/main.c", "v1\n");
        var file = await ReadOkAsync("repo/main.c");

        await SaveOkAsync("repo/main.c", new string('a', FileStore.MaxBytes), file.Version);

        Assert.Equal(FileStore.MaxBytes, (await ReadOkAsync("repo/main.c")).Content.Length);
    }

    [Fact]
    public async Task A_file_with_a_250_byte_name_can_be_read_and_saved()
    {
        var name = "repo/" + new string('n', 250);
        var path = Api.WriteProjectFile(name, "old\n");
        var file = await ReadOkAsync(name);

        await SaveOkAsync(name, "new\n", file.Version);

        Assert.Equal("new\n", File.ReadAllText(path));
        Assert.Equal(new[] { path }, Directory.GetFileSystemEntries(Api.ProjectPath("repo"), "*", new EnumerationOptions { AttributesToSkip = 0 }));
    }

    [Fact]
    public async Task A_save_keeps_a_private_mode_and_a_new_file_gets_the_default_mode()
    {
        var secret = Api.WriteProjectFile("repo/.env", "KEY=1\n");
        File.SetUnixFileMode(secret, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        // Created like a new file: with the default mode of this process (the umask applies).
        var reference = Api.WriteProjectFile("repo/reference.txt", "x");
        var file = await ReadOkAsync("repo/.env");

        await SaveOkAsync("repo/.env", "KEY=2\n", file.Version);
        await SaveOkAsync("repo/new.txt", "x", "absent");

        Assert.Equal("KEY=2\n", File.ReadAllText(secret));
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(secret));
        Assert.Equal(File.GetUnixFileMode(reference), File.GetUnixFileMode(Api.ProjectPath("repo/new.txt")));
    }

    [Fact]
    public async Task Content_with_a_nul_character_is_415_and_nothing_is_written()
    {
        var path = Api.WriteProjectFile("repo/main.c", "v1\n");
        var file = await ReadOkAsync("repo/main.c");

        Assert.Equal(HttpStatusCode.UnsupportedMediaType, (await SaveAsync("repo/main.c", "a\u0000b", file.Version)).StatusCode);
        Assert.Equal(HttpStatusCode.UnsupportedMediaType, (await SaveAsync("repo/new.c", "a\u0000b", "absent")).StatusCode);

        Assert.Equal("v1\n", File.ReadAllText(path));
        Assert.False(File.Exists(Api.ProjectPath("repo/new.c")));
    }

    // A lone UTF-16 surrogate has no UTF-8 form; the JSON binder refuses it before the save, like a malformed body.
    [Fact]
    public async Task Content_with_a_lone_surrogate_is_400_and_writes_nothing()
    {
        Directory.CreateDirectory(Api.ProjectPath("repo"));
        using var body = new StringContent("""{"content":"a\ud800b","baseVersion":"absent"}""", Encoding.UTF8, "application/json");

        var response = await Client.Http.PutAsync(Url("repo/new.c"), body);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.False(File.Exists(Api.ProjectPath("repo/new.c")));
    }

    [Fact]
    public async Task Error_responses_have_no_body()
    {
        Api.WriteProjectFile("repo/main.c", "v1\n");
        Api.WriteProjectFile("big/over.txt", Enumerable.Repeat((byte)'a', FileStore.MaxBytes + 1).ToArray());
        Api.WriteProjectFile("bin/cp1250.txt", [0x7A, 0xB3, 0x6F]);
        var file = await ReadOkAsync("repo/main.c");
        var tooLarge = new string('a', FileStore.MaxBytes + 1);

        (HttpStatusCode Status, HttpResponseMessage Response)[] answers =
        [
            (HttpStatusCode.BadRequest, await ReadAsync("../etc/passwd")),
            (HttpStatusCode.BadRequest, await SaveAsync("../new.txt", "x", "absent")),
            (HttpStatusCode.NotFound, await ReadAsync("repo/missing.c")),
            (HttpStatusCode.RequestEntityTooLarge, await ReadAsync("big/over.txt")),
            (HttpStatusCode.RequestEntityTooLarge, await SaveAsync("repo/main.c", tooLarge, file.Version)),
            (HttpStatusCode.UnsupportedMediaType, await ReadAsync("bin/cp1250.txt")),
            (HttpStatusCode.UnsupportedMediaType, await SaveAsync("repo/main.c", "a\u0000b", file.Version)),
        ];
        foreach (var (status, response) in answers)
        {
            Assert.Equal(status, response.StatusCode);
            Assert.Equal("", await response.Content.ReadAsStringAsync());
        }
    }

    [Fact]
    public async Task Saving_onto_an_existing_file_outside_or_in_git_through_a_link_is_400_also_with_its_real_version()
    {
        var config = Api.WriteProjectFile("repo/.git/config", "[core]\n");
        using var outside = new OutsideDirectory();
        var secret = outside.Child("secret.txt");
        File.WriteAllText(secret, "secret");
        Api.Link("repo/to-secret", secret);
        Api.Link("repo/to-config", config);

        Assert.Equal(HttpStatusCode.BadRequest, (await SaveAsync("repo/to-secret", "x", VersionOf(File.ReadAllBytes(secret)))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await SaveAsync("repo/to-config", "x", VersionOf(File.ReadAllBytes(config)))).StatusCode);

        Assert.Equal("secret", File.ReadAllText(secret));
        Assert.Equal("[core]\n", File.ReadAllText(config));
    }

    [Fact]
    public async Task Reading_and_saving_need_a_session()
    {
        Api.WriteProjectFile("repo/main.c", "v1\n");
        var stranger = new ApiClient(Api);

        Assert.Equal(HttpStatusCode.Unauthorized, (await stranger.Http.GetAsync(Url("repo/main.c"))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized,
            (await stranger.Http.PutAsJsonAsync(Url("repo/main.c"), new { content = "x", baseVersion = "absent" })).StatusCode);
    }

    private static string Url(string path) => $"/api/files/content?path={Uri.EscapeDataString(path)}";

    private static string VersionOf(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private Task<HttpResponseMessage> ReadAsync(string path) => Client.Http.GetAsync(Url(path));

    private Task<HttpResponseMessage> SaveAsync(string path, string content, string baseVersion) =>
        Client.Http.PutAsJsonAsync(Url(path), new { content, baseVersion });

    private async Task<FileBody> ReadOkAsync(string path)
    {
        var response = await ReadAsync(path);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<FileBody>())!;
    }

    private async Task<SavedBody> SaveOkAsync(string path, string content, string baseVersion)
    {
        var response = await SaveAsync(path, content, baseVersion);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<SavedBody>())!;
    }
}
