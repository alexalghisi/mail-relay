resource "aws_appautoscaling_target" "worker" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.service["worker"].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.worker_min_count
  max_capacity       = var.worker_max_count
}

# Scale on backlog per running worker (queued deliveries / tasks), so a burst
# of sends adds workers and they go away once the queue drains. QueueDepth
# comes from the workers' embedded metrics (src/queue/stats.ts).
resource "aws_appautoscaling_policy" "worker_backlog" {
  name               = "${var.name}-worker-backlog"
  service_namespace  = aws_appautoscaling_target.worker.service_namespace
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  policy_type        = "TargetTrackingScaling"

  target_tracking_scaling_policy_configuration {
    target_value       = var.worker_target_queue_depth
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    customized_metric_specification {
      metrics {
        id          = "backlog_per_task"
        expression  = "depth / IF(tasks < 1, 1, tasks)"
        label       = "Queued deliveries per worker"
        return_data = true
      }

      metrics {
        id          = "depth"
        return_data = false
        metric_stat {
          stat = "Maximum"
          metric {
            namespace   = "MailRelay"
            metric_name = "QueueDepth"
          }
        }
      }

      metrics {
        id          = "tasks"
        return_data = false
        metric_stat {
          stat = "Average"
          metric {
            namespace   = "ECS/ContainerInsights"
            metric_name = "RunningTaskCount"
            dimensions {
              name  = "ClusterName"
              value = aws_ecs_cluster.main.name
            }
            dimensions {
              name  = "ServiceName"
              value = "worker"
            }
          }
        }
      }
    }
  }
}
