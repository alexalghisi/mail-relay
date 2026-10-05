output "api_url" {
  value = "${var.certificate_arn == "" ? "http" : "https"}://${aws_lb.api.dns_name}"
}

output "db_endpoint" {
  value = aws_db_instance.main.address
}

output "db_secret_arn" {
  value = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "migrate_task_definition" {
  description = "Run with `aws ecs run-task` before deploying a release that needs new migrations."
  value       = aws_ecs_task_definition.service["migrate"].arn
}
