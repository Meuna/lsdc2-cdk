import { Construct } from 'constructs';
import { Stack, StackProps, RemovalPolicy, CfnOutput, CfnParameter, Duration } from 'aws-cdk-lib';
import { aws_iam as iam } from 'aws-cdk-lib';
import { aws_logs as logs } from 'aws-cdk-lib';
import { aws_s3 as s3 } from 'aws-cdk-lib';
import { aws_dynamodb as dynamodb } from 'aws-cdk-lib';
import { aws_ec2 as ec2 } from 'aws-cdk-lib';
import { aws_ecs as ecs } from 'aws-cdk-lib';
import { aws_sqs as sqs } from 'aws-cdk-lib';
import { aws_lambda as lambda } from 'aws-cdk-lib';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { aws_events as events } from 'aws-cdk-lib';
import { aws_events_targets as targets } from 'aws-cdk-lib';


export class Lsdc2CdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Arguments
    const discordParam = new CfnParameter(this, "discordParam", {
      type: "String",
      default: "/lsdc2/discord-secrets",
      description: "The name of the SSM parameter that hold Discord secrets."
    });

    // Context
    const discordBotBackendPath = String(this.node.tryGetContext('discordBotBackendPath'));
    const discordBotFrontendPath = String(this.node.tryGetContext('discordBotFrontendPath'));

    // Base resources
    const { bucket, specTable, guildTable, serverTable, instanceTable, botQueue } = this.setupDataResources()
    const { vpc, cluster, clusterLogGroup, executionRole, taskContainerRole, ec2Role, ec2Profile } = this.setupEngineResources(bucket, botQueue)

    // Setup discord bot lambdas

    // Bots env
    const discordBotEnv = {
      'DISCORD_PARAM': discordParam.valueAsString,
      'BOT_QUEUE_URL': botQueue.queueUrl,
      'VPC': vpc.vpcId,
      'SUBNETS': vpc.publicSubnets.map((sn) => sn.subnetId).join(';'),
      'LOG_GROUP': clusterLogGroup.logGroupName,
      'SAVEGAME_BUCKET': bucket.bucketName,
      'SPEC_TABLE': specTable.tableName,
      'GUILD_TABLE': guildTable.tableName,
      'SERVER_TABLE': serverTable.tableName,
      'INSTANCE_TABLE': instanceTable.tableName,
      'ECS_CLUSTER_NAME': cluster.clusterName,
      'ECS_EXECUTION_ROLE_ARN': executionRole.roleArn,
      'ECS_TASK_ROLE_ARN': taskContainerRole.roleArn,
      'EC2_VM_PROFILE_ARN': ec2Profile.attrArn,
    }

    // Lambda role
    const botIamPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: [taskContainerRole.roleArn, executionRole.roleArn, ec2Role.roleArn],
          actions: ['iam:PassRole'],
        }),
      ],
    });
    const botLogPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: [this.formatArn({ service: 'logs', resource: '*' })],
          actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
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
          resources: [specTable.tableArn, guildTable.tableArn, serverTable.tableArn, instanceTable.tableArn],
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
          actions: ['ecs:RunTask', 'ecs:StopTask', 'ecs:DescribeTasks', 'ecs:TagResource']
        }),
      ],
    });
    const botEc2Policy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: ['*'],
          actions: ['ec2:DescribeNetworkInterfaces', 'ec2:DescribeSecurityGroups', 'ec2:DescribeInstances', 'ec2:DescribeImages'],
        }),
        new iam.PolicyStatement({
          resources: [
            vpc.vpcArn,
            this.formatArn({ service: 'ec2', resource: 'security-group', resourceName: '*' }),
            this.formatArn({ service: 'ec2', resource: 'security-group-rule', resourceName: '*' }),
          ],
          actions: ['ec2:CreateSecurityGroup', 'ec2:DeleteSecurityGroup', 'ec2:AuthorizeSecurityGroupIngress', 'ec2:CreateTags'],
        }),
        new iam.PolicyStatement({
          resources: [
            this.formatArn({ service: 'ec2', resource: 'instance', resourceName: '*' }),
            this.formatArn({ service: 'ec2', resource: 'network-interface', resourceName: '*' }),
            this.formatArn({ service: 'ec2', resource: 'security-group', resourceName: '*' }),
            this.formatArn({ service: 'ec2', resource: 'volume', resourceName: '*' }),
            this.formatArn({ service: 'ec2', account: '', resource: 'image', resourceName: '*' }),
          ].concat(vpc.publicSubnets.map((sn) => this.formatArn({ service: 'ec2', resource: 'subnet', resourceName: sn.subnetId }))),
          actions: ['ec2:RunInstances', 'ec2:CreateTags', 'ec2:ModifyVolume'],
        }),
      ],
    });
    const botSqsPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: [botQueue.queueArn],
          actions: ['sqs:ReceiveMessage', 'sqs:SendMessage'],
        }),
      ],
    });
    const botSsmPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: [this.formatArn({ service: 'ssm', resource: 'parameter' + discordParam.valueAsString })],
          actions: ['ssm:GetParameter'],
        }),
        new iam.PolicyStatement({
          resources: ['*'],
          actions: ['ssm:SendCommand', 'ssm:ListCommandInvocations', 'ssm:GetCommandInvocation'],
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
        'ssm': botSsmPolicy,
      },
    });

    // Backend lambda
    const backFn = new lambda.Function(this, 'discordBotBackendLambda', {
      description: 'LSDC2 serverless discord bot backend',
      runtime: lambda.Runtime.PROVIDED_AL2023,
      handler: 'backend',
      code: lambda.Code.fromAsset(discordBotBackendPath),
      role: role,
      environment: discordBotEnv,
      timeout: Duration.minutes(2)
    });
    backFn.addEventSource(new SqsEventSource(botQueue, {
      batchSize: 1,
    }));
    new events.Rule(this, `ecsToBackendRule`, {
      eventPattern: {
        source: ["aws.ecs"],
        detailType: ["ECS Task State Change"],
        detail: {
          clusterArn: [cluster.clusterArn]
        }
      },
      targets: [new targets.LambdaFunction(backFn)]
    })
    new events.Rule(this, `ec2ToBackendRule`, {
      eventPattern: {
        source: ["aws.ec2"],
        detailType: ["EC2 Instance State-change Notification"],
      },
      targets: [new targets.LambdaFunction(backFn)]
    })

    // Frontend lambda
    const frontFn = new lambda.Function(this, 'discordBotFrontendLambda', {
      description: 'LSDC2 serverless discord bot frontend',
      runtime: lambda.Runtime.PROVIDED_AL2023,
      handler: 'frontend',
      code: lambda.Code.fromAsset(discordBotFrontendPath),
      role: role,
      environment: discordBotEnv,
    });
    const botUrl = frontFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // Output
    new CfnOutput(this, 'botUrl', {
      value: botUrl.url,
      description: 'The Discord interactions endpoint URL',
    });
  }

  setupDataResources() {
    // Bucket for server gamesave
    const bucket = new s3.Bucket(this, 'savegames', {
      versioned: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedOrigins: ["https://*.lambda-url." + this.region + ".on.aws"],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
        }
      ],
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
    const serverTable = new dynamodb.Table(this, 'server', {
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

    // Frontend/backend queue
    const botQueue = new sqs.Queue(this, 'discordBotQueue', {
      retentionPeriod: Duration.minutes(1),
      visibilityTimeout: Duration.minutes(2),
    });

    return { bucket, specTable, guildTable, serverTable, instanceTable, botQueue }
  }

  setupEngineResources(bucket: s3.Bucket, botQueue: sqs.Queue) {
    // Dedicated VPC
    const vpc = new ec2.Vpc(this, 'vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/24'),
      natGateways: 0,
      maxAzs: 4,  // FIXME: change to 2 AZs
      subnetConfiguration: [
        {
          cidrMask: 26,  // FIXME: change to 2 AZs (cidrMask=25)
          name: 'subnet',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
      gatewayEndpoints: {
        S3: {
          service: ec2.GatewayVpcEndpointAwsService.S3,
        }
      },
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

    // ECS container and EC2 role
    const instanceS3Policy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: [bucket.bucketArn],
          actions: ['s3:ListBucket']
        }),
        new iam.PolicyStatement({
          resources: [bucket.bucketArn + '/*'],
          actions: ['s3:PutObject', 's3:GetObject']
        }),
      ],
    });
    const instanceSqsPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: [botQueue.queueArn],
          actions: ['sqs:SendMessage'],
        }),
      ],
    });
    const taskContainerRole = new iam.Role(this, 'taskContainerRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Role for LSDC2 task container',
      inlinePolicies: {
        's3': instanceS3Policy,
        'sqs': instanceSqsPolicy,
      },
    });
    const ec2Role = new iam.Role(this, 'ec2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Role for LSDC2 ec2 instances',
      inlinePolicies: {
        's3': instanceS3Policy,
        'sqs': instanceSqsPolicy,
      },
    });
    ec2Role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
    );

    // EC2 instance profile
    const ec2Profile = new iam.CfnInstanceProfile(this, 'ec2Profile', {
      roles: [ec2Role.roleName],
    });

    return { vpc, cluster, clusterLogGroup, executionRole, taskContainerRole, ec2Role, ec2Profile }
  }
}
