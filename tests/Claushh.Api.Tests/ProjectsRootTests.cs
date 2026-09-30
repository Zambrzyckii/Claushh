using Microsoft.AspNetCore.Hosting;

namespace Claushh.Api.Tests;

public sealed class ProjectsRootTests(ApiFactory api)
{
    [Fact]
    public void The_api_refuses_to_start_without_an_existing_projects_directory() =>
        AssertRefusesToStart(Path.Join(api.ProjectsRoot, "missing"), "absolute path of an existing directory");

    [Fact]
    public void The_api_refuses_to_start_with_the_file_system_root_as_the_projects_directory() =>
        AssertRefusesToStart("/", "other than /");

    // A comparison of the configured text with "/" would not see this one.
    [Fact]
    public void The_api_refuses_to_start_with_a_symlink_to_the_file_system_root_as_the_projects_directory()
    {
        using var outside = new OutsideDirectory();
        File.CreateSymbolicLink(outside.Child("to-root"), "/");

        AssertRefusesToStart(outside.Child("to-root"), "other than /");
    }

    [Theory]
    [InlineData(UnixFileMode.None)]
    [InlineData(UnixFileMode.UserRead | UnixFileMode.UserExecute)]
    public void The_api_refuses_to_start_when_it_cannot_read_write_and_search_the_projects_directory(UnixFileMode mode)
    {
        // Directory permissions do not bind root.
        Assert.SkipWhen(Environment.IsPrivilegedProcess, "root can use every directory");
        using var outside = new OutsideDirectory();
        var root = Directory.CreateDirectory(outside.Child("projects")).FullName;
        File.SetUnixFileMode(root, mode);
        try
        {
            AssertRefusesToStart(root, "read, write and search");
        }
        finally
        {
            // The directory has to be deletable when the OutsideDirectory is disposed.
            File.SetUnixFileMode(root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }

    // The error has to name the key and say which check failed.
    private void AssertRefusesToStart(string root, string reason)
    {
        using var broken = api.WithWebHostBuilder(builder => builder.UseSetting("Projects:Root", root));

        var error = Assert.ThrowsAny<Exception>(() => broken.CreateClient()).ToString();

        Assert.Contains("Projects:Root", error, StringComparison.Ordinal);
        Assert.Contains(reason, error, StringComparison.Ordinal);
    }
}
