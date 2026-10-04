package com.minecraftctf;

import com.google.gson.Gson;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.FileSystemException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.logging.Logger;

final class ViewerStateWriter implements AutoCloseable {
    private final Gson gson = new Gson();
    private final Path destination;
    private final Logger logger;
    private final AtomicReference<Map<String, Object>> pending = new AtomicReference<>();
    private final AtomicBoolean writing = new AtomicBoolean();
    private final ExecutorService executor;
    private long lastWarning;

    ViewerStateWriter(Path destination, Logger logger) {
        this.destination = destination;
        this.logger = logger;
        executor = Executors.newSingleThreadExecutor(task -> {
            Thread thread = new Thread(task, "minecraftctf-viewer-state");
            thread.setDaemon(true);
            return thread;
        });
    }

    void publish(Map<String, Object> state) {
        pending.set(state);
        scheduleFlush();
    }

    private void scheduleFlush() {
        if (writing.compareAndSet(false, true)) executor.execute(this::drain);
    }

    private void drain() {
        do {
            try {
                while (pending.get() != null) flush();
            } finally {
                writing.set(false);
            }
        } while (pending.get() != null && writing.compareAndSet(false, true));
    }

    private void flush() {
        Map<String, Object> snapshot = pending.getAndSet(null);
        if (snapshot == null) return;
        Path temporary = destination.resolveSibling(destination.getFileName() + ".tmp");
        try {
            Files.writeString(temporary, gson.toJson(snapshot), StandardCharsets.UTF_8);
            replaceSnapshot(temporary);
        } catch (IOException exception) {
            if (System.currentTimeMillis() - lastWarning > 10_000L) {
                logger.warning("Viewer snapshot write failed: " + exception);
                lastWarning = System.currentTimeMillis();
            }
        }
    }

    private void replaceSnapshot(Path temporary) throws IOException {
        for (int attempt = 0; ; attempt++) {
            try {
                try {
                    Files.move(temporary, destination, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
                } catch (AtomicMoveNotSupportedException exception) {
                    Files.move(temporary, destination, StandardCopyOption.REPLACE_EXISTING);
                }
                return;
            } catch (FileSystemException exception) {
                if (attempt >= 20) throw exception;
                try {
                    TimeUnit.MILLISECONDS.sleep(Math.min(100L, 10L * (attempt + 1)));
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IOException("Interrupted while replacing viewer snapshot", interrupted);
                }
            }
        }
    }

    @Override public void close() {
        executor.shutdown();
        try {
            if (!executor.awaitTermination(3, TimeUnit.SECONDS)) executor.shutdownNow();
        } catch (InterruptedException exception) {
            executor.shutdownNow();
            Thread.currentThread().interrupt();
        }
        flush();
    }
}
