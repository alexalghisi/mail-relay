resource "aws_db_subnet_group" "main" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_parameter_group" "postgres16" {
  name   = "${var.name}-pg16"
  family = "postgres16"

  # Log anything slower than 250 ms so slow queries show up before they hurt.
  parameter {
    name  = "log_min_duration_statement"
    value = "250"
  }

  # A worker that dies mid-transaction must not hold row locks on the queue.
  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }

  # Migrations take a lock and give up instead of queueing behind long
  # transactions and blocking every query that arrives after them.
  parameter {
    name  = "lock_timeout"
    value = "10000"
  }

  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }
}

resource "aws_db_instance" "main" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class
  db_name        = "mailrelay"
  username       = "mailrelay"

  # The password lives in Secrets Manager and is rotated by RDS.
  manage_master_user_password = true

  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_allocated_storage_gb * 4
  storage_type          = "gp3"
  storage_encrypted     = true

  multi_az               = var.db_multi_az
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.postgres16.name

  backup_retention_period         = 14
  performance_insights_enabled    = true
  enabled_cloudwatch_logs_exports = ["postgresql"]
  auto_minor_version_upgrade      = true
  deletion_protection             = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${var.name}-final"
}
