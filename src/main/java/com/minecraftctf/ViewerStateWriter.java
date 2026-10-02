package com.minecraftctf;

import com.google.gson.Gson;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.FileSystemException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.logging.Logger;

final class ViewerStateWriter implements AutoCloseable {
    private final Gson gson = new Gson();
    private final Path destination;
    private final Logger logger;
    private final AtomicReference<String> pending = new AtomicReference<>();
    private final ScheduledExecutorService executor;
    private long lastWarning;

    ViewerStateWriter(Path destination, Logger logger) {
        this.destination = destination;
        this.logger = logger;
        executor = Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task, "minecraftctf-viewer-state");
            thread.setDaemon(true);
            return thread;
        });
        executor.scheduleWithFixedDelay(this::flush, 0, 100, TimeUnit.MILLISECONDS);
    }

    void publish(Map<String, Object> state) {
        pending.set(gson.toJson(state));
    }

    private void flush() {
        String snapshot = pending.getAndSet(null);
        if (snapshot == null) return;
        try {
            Files.writeString(destination, snapshot, StandardCharsets.UTF_8,
                    java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.TRUNCATE_EXISTING,
                    java.nio.file.StandardOpenOption.WRITE);
        } catch (IOException exception) {
            if (System.currentTimeMillis() - lastWarning > 10_000L) {
                logger.warning("Viewer snapshot write failed: " + exception);
                lastWarning = System.currentTimeMillis();
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
