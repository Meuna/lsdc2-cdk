import { Construct } from 'constructs';
import { Stack, StackProps, RemovalPolicy, CfnOutput, Duration } from 'aws-cdk-lib';
import { aws_iam as iam } from 'aws-cdk-lib';
import { aws_logs as logs } from 'aws-cdk-lib';
import { aws_s3 as s3 } from 'aws-cdk-lib';
import { aws_dynamodb as dynamodb } from 'aws-cdk-lib';
import { aws_ec2 as ec2 } from 'aws-cdk-lib';
import { aws_ecs as ecs } from 'aws-cdk-lib';
import { aws_sqs as sqs } from 'aws-cdk-lib';
import { aws_lambda as lambda } from 'aws-cdk-lib';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';


export class Lsdc2CdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Context
    const discordBotBackendPath = String(this.node.tryGetContext('discordBotBackendPath'));
    const discordBotFrontendPath = String(this.node.tryGetContext('discordBotFrontendPath'));

    // Base resources
    const { bucket, specTable, guildTable, instanceTable } = this.setupStateResources()
    const { vpc, cluster, clusterLogGroup, executionRole, taskRole } = this.setupClusterResources(bucket)

    // Setup discord bot lambdas
    // Frontend/backend queue
    const botQueue = new sqs.Queue(this, 'discordBotQueue', {
      retentionPeriod: Duration.minutes(1),
      visibilityTimeout: Duration.minutes(2),
    });

    // Bots env
    const discordBotEnv = {
      'DISCORD_PKEY': 'To be filled with Discord bot public key',
      'DISCORD_TOKEN': 'To be filled with Discord bot token',
      'BOT_QUEUE_URL': botQueue.queueUrl,
      'VPC': vpc.vpcId,
      'SUBNETS': vpc.publicSubnets.map((sn) => sn.subnetId).join(';'),
      'CLUSTER': cluster.clusterName,
      'LOG_GROUP': clusterLogGroup.logGroupName,
      'SAVEGAME_BUCKET': bucket.bucketName,
      'SPEC_TABLE': specTable.tableName,
      'GUILD_TABLE': guildTable.tableName,
      'INSTANCE_TABLE': instanceTable.tableName,
      'EXECUTION_ROLE_ARN': executionRole.roleArn,
      'TASK_ROLE_ARN': taskRole.roleArn,
    }

    // Lambda role
    const botLogPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: [this.formatArn({ service: 'logs', resource: '*' })],
          actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        }),
      ],
    });
    const botIamPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: [taskRole.roleArn, executionRole.roleArn],
          actions: ['iam:PassRole'],
        }),
      ],
    });
    const botSqsPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: [botQueue.queueArn],
          actions: ['sqs:ChangeMessageVisibility', 'sqs:GetQueueUrl', 'sqs:DeleteMessage', 'sqs:ReceiveMessage', 'sqs:SendMessage', 'sqs:GetQueueAttributes'],
        }),
      ],
    });
    const botDynamoPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: [bucket.bucketArn + "/*"],
          actions: ['s3:PutObject', 's3:GetObject']
        }),
        new iam.PolicyStatement({
          resources: [specTable.tableArn, guildTable.tableArn, instanceTable.tableArn],
          actions: ['dynamodb:GetItem', 'dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:DeleteItem']
        }),
      ],
    });
    const botEcsPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: ['*'],
          actions: ['ecs:RegisterTaskDefinition', 'ecs:DeregisterTaskDefinition', 'ecs:ListTaskDefinitions']
        }),
        new iam.PolicyStatement({
          resources: [
            this.formatArn({ service: 'ecs', resource: 'task-definition', resourceName: 'lsdc2*' }),
            this.formatArn({ service: 'ecs', resource: 'task', resourceName: cluster.clusterName + '*' }),
          ],
          actions: ['ecs:RunTask', 'ecs:StopTask', 'ecs:DescribeTasks']
        }),
      ],
    });
    const botEc2Policy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: ['*'],
          actions: ['ec2:DescribeNetworkInterfaces', 'ec2:DescribeSecurityGroups'],
        }),
        new iam.PolicyStatement({
          resources: [
            vpc.vpcArn,
            this.formatArn({ service: 'ec2', resource: 'security-group', resourceName: '*' }),
            this.formatArn({ service: 'ec2', resource: 'security-group-rule', resourceName: '*' }),
          ],
          actions: ['ec2:CreateSecurityGroup', 'ec2:DeleteSecurityGroup', 'ec2:AuthorizeSecurityGroupIngress'],
        }),
      ],
    });
    const role = new iam.Role(this, 'discordBotRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for the LSDC2 discord bot',
      inlinePolicies: {
        'iam': botIamPolicy,
        'log': botLogPolicy,
        'dynamo': botDynamoPolicy,
        'ecs': botEcsPolicy,
        'ec2': botEc2Policy,
        'sqs': botSqsPolicy,
      },
    });

    // Backend lambda
    const backFn = new lambda.Function(this, 'discordBotBackendLambda', {
      description: 'LSDC2 serverless discord bot backend',
      runtime: lambda.Runtime.GO_1_X,
      handler: 'backend',
      code: lambda.Code.fromAsset(discordBotBackendPath),
      role: role,
      environment: discordBotEnv
    });
    backFn.addEventSource(new SqsEventSource(botQueue, {
      batchSize: 1,
    }));

    // Frontend lambda (with a function url)
    const frontFn = new lambda.Function(this, 'discordBotFrontendLambda', {
      description: 'LSDC2 serverless discord bot frontend',
      runtime: lambda.Runtime.GO_1_X,
      handler: 'frontend',
      code: lambda.Code.fromAsset(discordBotFrontendPath),
      role: role,
      environment: discordBotEnv,
      timeout: Duration.minutes(1)
    });
    const botUrl = frontFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // Output
    new CfnOutput(this, 'bucketName', {
      value: botUrl.url,
      description: 'The Discord interactions endpoint URL',
    });
  }

  setupStateResources() {
    // Bucket for server gamesave
    const bucket = new s3.Bucket(this, 'savegames', {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // State tables
    const specTable = new dynamodb.Table(this, 'spec', {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      tableClass: dynamodb.TableClass.STANDARD_INFREQUENT_ACCESS,
      removalPolicy: RemovalPolicy.DESTROY,
      partitionKey: { name: 'key', type: dynamodb.AttributeType.STRING },
    });
    const guildTable = new dynamodb.Table(this, 'guild', {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      tableClass: dynamodb.TableClass.STANDARD_INFREQUENT_ACCESS,
      removalPolicy: RemovalPolicy.DESTROY,
      partitionKey: { name: 'key', type: dynamodb.AttributeType.STRING },
    });
    const instanceTable = new dynamodb.Table(this, 'instance', {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      tableClass: dynamodb.TableClass.STANDARD_INFREQUENT_ACCESS,
      removalPolicy: RemovalPolicy.DESTROY,
      partitionKey: { name: 'key', type: dynamodb.AttributeType.STRING },
    });

    return { bucket, specTable, guildTable, instanceTable }
  }

  setupClusterResources(bucket: s3.Bucket) {
    // Dedicated VPC
    const vpc = new ec2.Vpc(this, 'vpc', {
      cidr: "10.0.0.0/24",
      natGateways: 0,
      maxAzs: 4,
      subnetConfiguration: [
        {
          cidrMask: 26,
          name: 'subnet',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ]
    });

    // Cluster
    const cluster = new ecs.Cluster(this, 'cluster', {
      vpc: vpc,
      enableFargateCapacityProviders: true,
    });

    // Log group for tasks
    const clusterLogGroup = new logs.LogGroup(this, 'servers', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Task execution role
    const logPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: [clusterLogGroup.logGroupArn],
          actions: ['logs:CreateLogStream', 'logs:PutLogEvents']
        }),
      ],
    });
    const executionRole = new iam.Role(this, 'executionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Role for LSDC2 task execution',
      inlinePolicies: {
        'logging': logPolicy
      },
    });

    // Task container role
    const s3Policy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: [bucket.bucketArn + '/*'],
          actions: ['s3:PutObject', 's3:GetObject']
        }),
      ],
    });
    const taskRole = new iam.Role(this, 'taskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Role for LSDC2 task container',
      inlinePolicies: {
        's3': s3Policy
      },
    });

    return { vpc, cluster, clusterLogGroup, executionRole, taskRole }
  }
}
