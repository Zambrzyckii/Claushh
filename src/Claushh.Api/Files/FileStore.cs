// Reading and saving files for the editor: versions, the size limit, text checks and saves that never leave a
// half-written file (docs/ARCHITECTURE.md, "Files and editor"; decisions: docs/PLAN.md, "Backend decisions (stage 2)").
using System.Security.Cryptography;
using System.Text;

namespace Claushh.Api.Files;

public enum ReadStatus { Ok, NotFound, TooLarge, NotText }

public sealed record ReadResult(ReadStatus Status, string Content = "", string Version = "");

public enum SaveStatus { Saved, Invalid, NotFound, Conflict, TooLarge, NotText }

// Version: of the file now on disk (Saved), or the one that is there instead of the expected one (Conflict).
public sealed record SaveResult(SaveStatus Status, string Version = "");

public sealed class FileStore
{
    public const int MaxBytes = 5 * 1024 * 1024;
    public const string AbsentVersion = "absent";

    private static readonly byte[] Bom = [0xEF, 0xBB, 0xBF];
    private static readonly UTF8Encoding StrictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    // Saves of one file run one at a time; two files share a lock only when their paths hash alike.
    private readonly SemaphoreSlim[] _locks = Enumerable.Range(0, 64).Select(_ => new SemaphoreSlim(1, 1)).ToArray();

    public async Task<ReadResult> ReadAsync(ProjectPath file, CancellationToken ct)
    {
        if (file.Kind != PathKind.File)
        {
            return new(ReadStatus.NotFound);
        }
        ReadOnlyMemory<byte> bytes;
        try
        {
            var length = new FileInfo(file.FullPath).Length;
            if (length > MaxBytes)
            {
                return new(ReadStatus.TooLarge);
            }
            bytes = await ReadAtMostAsync(file.FullPath, length, ct);
        }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException)
        {
            return new(ReadStatus.NotFound);
        }
        if (bytes.Length > MaxBytes)
        {
            return new(ReadStatus.TooLarge);
        }
        var text = DecodeText(bytes.Span);
        return text is null ? new(ReadStatus.NotText) : new(ReadStatus.Ok, text, VersionOf(bytes.Span));
    }

    public async Task<SaveResult> SaveAsync(ProjectPath file, string content, string baseVersion, CancellationToken ct)
    {
        switch (file.Kind)
        {
            case PathKind.NotFound:
                return new(SaveStatus.NotFound);
            case PathKind.Directory or PathKind.Other:
                return new(SaveStatus.Invalid);
        }
        // Only text that the next read accepts is written: no NUL character, and no lone UTF-16 surrogate, which has no
        // UTF-8 form.
        if (content.Contains('\0'))
        {
            return new(SaveStatus.NotText);
        }
        int size;
        try
        {
            size = StrictUtf8.GetByteCount(content);
        }
        catch (EncoderFallbackException)
        {
            return new(SaveStatus.NotText);
        }
        if (size > MaxBytes)
        {
            return new(SaveStatus.TooLarge);
        }
        var text = StrictUtf8.GetBytes(content);
        var fileLock = _locks[(uint)StringComparer.Ordinal.GetHashCode(file.FullPath) % (uint)_locks.Length];
        await fileLock.WaitAsync(ct);
        try
        {
            var current = await CurrentAsync(file.FullPath, ct);
            var currentVersion = current?.Version ?? AbsentVersion;
            if (currentVersion != baseVersion)
            {
                return new(SaveStatus.Conflict, currentVersion);
            }
            byte[] bytes = current is { Bom: true } ? [.. Bom, .. text] : text;
            if (bytes.Length > MaxBytes)
            {
                return new(SaveStatus.TooLarge);
            }
            try
            {
                return await WriteAtomicallyAsync(file.FullPath, bytes, baseVersion, replacing: current is not null, ct);
            }
            catch (DirectoryNotFoundException)
            {
                return new(SaveStatus.NotFound);
            }
        }
        finally
        {
            fileLock.Release();
        }
    }

    // What the editor shows for the bytes of a file: null for a NUL byte or invalid UTF-8, otherwise the text without a
    // leading UTF-8 BOM. The size limit (MaxBytes) is up to the caller.
    internal static string? DecodeText(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Contains((byte)0))
        {
            return null;
        }
        try
        {
            return StrictUtf8.GetString(bytes[(HasBom(bytes) ? Bom.Length : 0)..]);
        }
        catch (DecoderFallbackException)
        {
            return null;
        }
    }

    private static string VersionOf(ReadOnlySpan<byte> bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private static bool HasBom(ReadOnlySpan<byte> bytes) => bytes.StartsWith(Bom);

    // The bytes of the file, at most MaxBytes + 1 of them: one more than the limit is enough to refuse it. The buffer has
    // the length measured a moment ago plus one byte, so a file that did not change is read into an array of its own
    // size; the loop is for one that has grown since.
    private static async Task<ReadOnlyMemory<byte>> ReadAtMostAsync(string path, long length, CancellationToken ct)
    {
        await using var stream = File.OpenRead(path);
        var buffer = new byte[length + 1];
        var read = await stream.ReadAtLeastAsync(buffer, buffer.Length, throwOnEndOfStream: false, ct);
        while (read == buffer.Length && read <= MaxBytes)
        {
            Array.Resize(ref buffer, (int)Math.Min(2L * buffer.Length, MaxBytes + 1));
            read += await stream.ReadAtLeastAsync(buffer.AsMemory(read), buffer.Length - read, throwOnEndOfStream: false, ct);
        }
        return buffer.AsMemory(0, read);
    }

    // The version, the BOM and the Unix mode of the file now on disk, hashed as a stream (it may have grown past the
    // limit); null when there is no file.
    private static async Task<(string Version, bool Bom, UnixFileMode Mode)?> CurrentAsync(string path, CancellationToken ct)
    {
        try
        {
            await using var stream = File.OpenRead(path);
            // From the open file, so that the mode belongs to the bytes that are hashed.
            var mode = File.GetUnixFileMode(stream.SafeFileHandle);
            var head = new byte[Bom.Length];
            var read = await stream.ReadAtLeastAsync(head, head.Length, throwOnEndOfStream: false, ct);
            stream.Position = 0;
            var hash = await SHA256.HashDataAsync(stream, ct);
            return (Convert.ToHexStringLower(hash), read == Bom.Length && HasBom(head), mode);
        }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
    }

    // Written next to the file, flushed to disk, checked once more against the version the save is based on, then renamed
    // over the file: readers see the old or the new file, never half, and a change that was made while the temporary file
    // was written is not overwritten (what is left is the time to hash the file and rename). The name of the temporary
    // file does not contain the file's name, which may leave no room for a suffix. A temporary file that replaces a file
    // is created for its owner only and gets the old file's mode last, so a private file is never readable by others
    // while its new content is written.
    private static async Task<SaveResult> WriteAtomicallyAsync(
        string path, byte[] bytes, string baseVersion, bool replacing, CancellationToken ct)
    {
        var temporary = Path.Join(Path.GetDirectoryName(path), $".claushh-{Guid.NewGuid():N}.tmp");
        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
        if (replacing)
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }
        try
        {
            string latestVersion;
            await using (var stream = new FileStream(temporary, options))
            {
                await stream.WriteAsync(bytes, ct);
                stream.Flush(flushToDisk: true);
                var latest = await CurrentAsync(path, ct);
                latestVersion = latest?.Version ?? AbsentVersion;
                if (latestVersion == baseVersion && latest is { } existing)
                {
                    File.SetUnixFileMode(stream.SafeFileHandle, existing.Mode);
                }
            }
            if (latestVersion != baseVersion)
            {
                File.Delete(temporary);
                return new(SaveStatus.Conflict, latestVersion);
            }
            File.Move(temporary, path, overwrite: true);
            return new(SaveStatus.Saved, VersionOf(bytes));
        }
        catch
        {
            File.Delete(temporary);
            throw;
        }
    }
}
