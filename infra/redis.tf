resource "aws_elasticache_subnet_group" "main" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}

# Only holds rate-limit buckets. Losing it means a few seconds without rate
# limiting (the API fails open), not lost data, so one replica is enough.
resource "aws_elasticache_replication_group" "main" {
  replication_group_id       = var.name
  description                = "API rate limiting"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.redis_node_type
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.redis.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
}
