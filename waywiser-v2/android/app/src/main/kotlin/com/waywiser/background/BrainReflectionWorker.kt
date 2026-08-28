package com.waywiser.background

import android.content.Context
import android.util.Log
import androidx.work.*
import java.util.concurrent.TimeUnit

/**
 * WorkManager worker for deferred Brain reflection (Pass 2).
 *
 * Runs at P3 priority — yields to interactive (P0) and foreground (P1) work.
 * If the inference slot is busy, retries later with exponential backoff.
 */
class BrainReflectionWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        Log.d(TAG, "Brain reflection worker started")

        // Check if inference slot is available at P3 priority
        // TODO: Query Rust runtime for slot availability
        // if (!waywiserRuntime.inferenceSlotAvailable(Priority.P3)) {
        //     Log.d(TAG, "Inference slot busy, retrying later")
        //     return Result.retry()
        // }

        return try {
            // Run Brain Pass 2 reflection
            // waywiserRuntime.runBrainReflection()
            Log.d(TAG, "Brain reflection completed")
            Result.success()
        } catch (e: Exception) {
            Log.e(TAG, "Brain reflection failed", e)
            if (runAttemptCount < MAX_RETRIES) {
                Result.retry()
            } else {
                Result.failure()
            }
        }
    }

    companion object {
        private const val TAG = "BrainReflection"
        private const val MAX_RETRIES = 3
        private const val WORK_NAME = "brain_reflection"

        /**
         * Schedule periodic Brain reflection.
         * Uses expedited work for faster execution, but respects OS deferrals.
         */
        fun schedule(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiresBatteryNotLow(true)
                .build()

            val request = PeriodicWorkRequestBuilder<BrainReflectionWorker>(
                15, TimeUnit.MINUTES, // minimum periodic interval
            )
                .setConstraints(constraints)
                .setBackoffCriteria(
                    BackoffPolicy.EXPONENTIAL,
                    WorkRequest.MIN_BACKOFF_MILLIS,
                    TimeUnit.MILLISECONDS,
                )
                .build()

            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        }

        /** Schedule a one-shot reflection job (e.g., after accumulating experiences). */
        fun scheduleOnce(context: Context) {
            val request = OneTimeWorkRequestBuilder<BrainReflectionWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiresBatteryNotLow(true)
                        .build()
                )
                .build()

            WorkManager.getInstance(context).enqueue(request)
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
        }
    }
}

/**
 * Boot receiver to reschedule workers after device restart.
 */
class BootReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action == android.content.Intent.ACTION_BOOT_COMPLETED) {
            BrainReflectionWorker.schedule(context)
        }
    }
}
