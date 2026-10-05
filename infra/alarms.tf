resource "aws_sns_topic" "alarms" {
  name = "${var.name}-alarms"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alarm_actions = [aws_sns_topic.alarms.arn]
}

# The most direct signal that sending is falling behind: the oldest delivery
# that is due has been waiting too long. Catches stuck workers, a saturated
# database and a burst the autoscaler can't keep up with.
resource "aws_cloudwatch_metric_alarm" "queue_age" {
  alarm_name          = "${var.name}-queue-age"
  namespace           = "MailRelay"
  metric_name         = "OldestDueAgeSeconds"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = var.queue_age_alarm_seconds
  comparison_operator = "GreaterThanThreshold"
  # No data means no worker is reporting, which is itself a problem.
  treat_missing_data = "breaching"
  alarm_actions      = local.alarm_actions
  ok_actions         = local.alarm_actions
}

# Deliveries that exhausted their retries: the dead-letter state.
resource "aws_cloudwatch_metric_alarm" "dead_letters" {
  alarm_name          = "${var.name}-dead-letters"
  namespace           = "MailRelay"
  metric_name         = "DeadLastHour"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 50
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${var.name}-api-5xx"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.api.arn_suffix }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "api_latency_p95" {
  alarm_name          = "${var.name}-api-latency-p95"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = { LoadBalancer = aws_lb.api.arn_suffix }
  extended_statistic  = "p95"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = 0.5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name          = "${var.name}-db-cpu"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_actions
}
