/**
 * @fileoverview Trigger creation for aws-Lambda function invocations
 */
const uuid4 = require('uuid4');
const md5 = require('md5');
JSON.sortify = require('json.sortify');
const tryRequire = require('../try_require.js');
const serverlessEvent = require('../proto/event_pb.js');
const errorCode = require('../proto/error_code_pb.js');
const eventInterface = require('../event.js');
const utils = require('../utils');
const resourceUtils = require('../resource_utils/sqs_utils.js');
const config = require('../config.js');

const AWS = tryRequire('aws-sdk');

/**
 * Fills the common fields for a trigger event
 * @param {proto.event_pb.Event} trigger The trigger whose fields are being filled
 * @param {string} resourceType The type of the resource that initiated the trigger
 */
function fillCommonFields(trigger, resourceType) {
    trigger.setStartTime(utils.createTimestamp());
    trigger.setDuration(utils.createTimestampFromTime(0));
    trigger.setOrigin('trigger');
    trigger.getResource().setType(resourceType);
    trigger.setErrorCode(errorCode.ErrorCode.OK);
}

/**
 * Initializes an event representing a trigger to the lambda caused by JSON (invoke)
 * @param {object} event The event the Lambda was triggered with
 * @param {proto.event_pb.Event} trigger An Event to initialize as the trigger
 * @param {object} context The context the Lambda was triggered with
 */
function createJSONTrigger(event, trigger, context) {
    const resource = trigger.getResource();
    trigger.setId(`trigger-${uuid4()}`);
    resource.setName(`trigger-${context.functionName}`);
    resource.setOperation('Event');
    eventInterface.addToMetadata(trigger, {}, {
        data: event,
    });
}

/**
 * Initializes an event representing a trigger to the lambda caused by S3
 * @param {object} event The event the lambda was triggered with
 * @param {proto.event_pb.Event} trigger An Event to initialize as the trigger
 */
function createS3Trigger(event, trigger) {
    const resource = trigger.getResource();
    trigger.setId(event.Records[0].responseElements['x-amz-request-id']);
    resource.setName(event.Records[0].s3.bucket.name);
    resource.setOperation(event.Records[0].eventName);
    eventInterface.addToMetadata(trigger, {
        region: `${event.Records[0].awsRegion}`,
        request_parameters: JSON.stringify(event.Records[0].requestParameters),
        user_identity: JSON.stringify(event.Records[0].userIdentity),
        object_key: `${event.Records[0].s3.object.key}`,
        object_size: `${event.Records[0].s3.object.size}`,
        object_etag: `${event.Records[0].s3.object.eTag}`,
        'x-amz-request-id': `${event.Records[0].responseElements['x-amz-request-id']}`,
    });
}

/**
 * Initializes an event representing a trigger to the lambda caused by Kinesis
 * @param {object} event The event the lambda was triggered with
 * @param {proto.event_pb.Event} trigger An Event to initialize as the trigger
 */
function createKinesisTrigger(event, trigger) {
    const resource = trigger.getResource();
    trigger.setId(event.Records[0].eventID);
    resource.setName(event.Records[0].eventSourceARN.split('/').pop());
    resource.setOperation(event.Records[0].eventName.replace('aws:kinesis:', ''));
    eventInterface.addToMetadata(trigger, {
        region: event.Records[0].awsRegion,
        invoke_identity: event.Records[0].invokeIdentityArn,
        sequence_number: event.Records[0].kinesis.sequenceNumber,
        partition_key: event.Records[0].kinesis.partitionKey,
        total_record_count: event.Records.length,
    });
}

/**
 * Initializes an event representing a trigger to the lambda caused by SNS
 * @param {object} event The event the lambda was triggered with
 * @param {proto.event_pb.Event} trigger An Event to initialize as the trigger
 */
function createSNSTrigger(event, trigger) {
    const resource = trigger.getResource();
    trigger.setId(event.Records[0].Sns.MessageId);
    resource.setName(event.Records[0].EventSubscriptionArn.split(':').slice(-2)[0]);
    resource.setOperation(event.Records[0].Sns.Type);
    eventInterface.addToMetadata(trigger, {
        'Notification Subject': event.Records[0].Sns.Subject,
    }, {
        'Notification Message': event.Records[0].Sns.Message,
        'Notification Message Attributes': event.Records[0].Sns.MessageAttributes,
    });
}

const MAX_SQS_BODY_LENGTH = 1 * 1024; // (1K)
/**
 * Initializes an event representing a trigger to the lambda caused by SQS
 * @param {object} event The event the lambda was triggered with
 * @param {proto.event_pb.Event} trigger An Event to initialize as the trigger
 */
function createSQSTrigger(event, trigger) {
    const resource = trigger.getResource();
    trigger.setId(event.Records[0].messageId);
    resource.setName(event.Records[0].eventSourceARN.split(':').slice(-1)[0]);
    resource.setOperation('ReceiveMessage');
    const sqsMessageBody = event.Records[0].body || '{}';
    eventInterface.addToMetadata(trigger, {
        record: event.Records.map((r) => {
            const record = {
                'MD5 Of Message Body': r.md5OfBody,
                'Message ID': r.messageId,
            };
            if (!config.getConfig().metadataOnly) {
                record['Message Body'] = utils.truncateMessage(r.body || '{}', MAX_SQS_BODY_LENGTH);
                record.Attributes = r.attributes;
                record['Message Attributes'] = r.messageAttributes;
            }
            return record;
        }),
        total_record_count: event.Records.length,
    });
    try {
        const messageBody = JSON.parse(sqsMessageBody);
        // Extracting sqs data in case of is a part of a step functions flow.
        if (messageBody.input && messageBody.input.Epsagon) {
            eventInterface.addToMetadata(trigger, {
                steps_dict: messageBody.input.Epsagon,
            });
        }
    } catch (err) {
        utils.debugLog(`Could not parse SQS message body: ${sqsMessageBody}`);
    }

    const snsData = resourceUtils.getSNSTrigger(event.Records);
    if (snsData != null) {
        eventInterface.addToMetadata(trigger, { 'SNS Trigger': snsData });
    }
}

/**
 * Initializes an event representing a trigger to the lambda caused by API Trigger
 * @param {object} event The event the lambda was triggered with
 * @param {proto.event_pb.Event} trigger An Event to initialize as the trigger
 */
function createAPIGatewayTrigger(event, trigger) {
    const resource = trigger.getResource();
    trigger.setId(event.requestContext.requestId);
    resource.setName(event.headers.Host || event.requestContext.apiId);
    resource.setOperation(event.httpMethod);
    eventInterface.addToMetadata(trigger, {
        stage: event.requestContext.stage,
        query_string_parameters: event.queryStringParameters,
        path_parameters: event.pathParameters,
        path: event.resource,
    }, {
        body: event.body,
        headers: event.headers,
        requestContext: event.requestContext,
    });
}

/**
 * Initializes an event representing a trigger to the lambda caused by HTTP API v2 Trigger
 * @param {object} event The event the lambda was triggered with
 * @param {proto.event_pb.Event} trigger An Event to initialize as the trigger
 */
function createAPIGatewayHTTPV2Trigger(event, trigger) {
    const resource = trigger.getResource();
    trigger.setId(event.requestContext.requestId);
    resource.setName(event.headers.Host || event.requestContext.domainName);
    resource.setOperation(event.requestContext.http.method);
    eventInterface.addToMetadata(trigger, {
        stage: event.requestContext.stage,
        query_string_parameters: event.queryStringParameters,
        path_parameters: event.pathParameters,
        path: event.requestContext.http.path,
        'aws.api_gateway.api_id': event.requestContext.apiId,
    }, {
        body: event.body,
        headers: event.headers,
        requestContext: event.requestContext,
    });
}

/**
 * Initializes an event representing a trigger to the lambda caused by No-Proxy API Trigger
 * @param {object} event The event the lambda was triggered with
 * @param {proto.event_pb.Event} trigger An Event to initialize as the trigger
 */
function createNoProxyAPIGatewayTrigger(event, trigger) {
    const resource = trigger.getResource();
    trigger.setId(event.context['request-id']);
    resource.setName(event.params.header.Host || event.context['api-id']);
    resource.setOperation(event.context['http-method']);
    eventInterface.addToMetadata(trigger, {
        stage: event.context.stage,
        query_string_parameters: event.params.querystring,
        path_parameters: event.params.path,
        path: event.context['resource-path'],
    }, {
        body: event['body-json'],
        headers: event.params.header,
    });
}

/**
 * Initializes an event representing a trigger to the lambda caused by Web Socket API Trigger
 * @param {object} event The event the lambda was triggered with
 * @param {proto.event_pb.Event} trigger An Event to initialize as the trigger
 */
function createWebSocketTrigger(event, trigger) {
    const resource = trigger.getResource();
    trigger.setId(event.requestContext.requestId);
    resource.setName(event.requestContext.domainName);
    resource.setOperation(event.requestContext.eventType || 'CONNECT');
    eventInterface.addToMetadata(trigger, {
        stage: event.requestContext.stage,
        route_key: event.requestContext.routeKey,
        message_id: event.requestContext.messageId,
        connection_id: event.requestContext.connectionId,
        request_id: event.requestContext.requestId,
        message_direction: event.requestContext.messageDirection,
    }, {
        body: event.body,
    });
}

/**
 * Initializes an event representing a trigger to the lambda caused by Events
 * @param {object} event The event the lambda was triggered with
 * @param {proto.event_pb.Event} trigger An Event to initialize as the trigger
 */
function createEventsTrigger(event, trigger) {
    const resource = trigger.getResource();
    trigger.setId(event.id);
    let name = 'CloudWatch Events';
    if (typeof event.resources[0] === 'string') {
        name = event.resources[0].split('/').pop();
    }
    resource.setName(name);
    resource.setOperation(event['detail-type']);
    eventInterface.addToMetadata(trigger, {
        region: event.region,
        detail: JSON.stringify(event.detail),
        account: event.account,
    });
}

/**
 * Initializes an event representing a trigger to the lambda caused by DynamoDB
 * @param {object} event The event the lambda was triggered with
 * @param {proto.event_pb.Event} trigger An Event to initialize as the trigger
 */
function createDynamoDBTrigger(event, trigger) {
    const resource = trigger.getResource();
    const record = event.Records[0];
    let itemHash = '';
    if (AWS) {
        // in case of a delete - hash only the key.
        const item = (
            record.eventName === 'REMOVE' ?
                AWS.DynamoDB.Converter.unmarshall(record.dynamodb.Keys) :
                AWS.DynamoDB.Converter.unmarshall(record.dynamodb.NewImage)
        );
        itemHash = md5(JSON.sortify(item));
    }
    trigger.setId(record.eventID);
    resource.setName(record.eventSourceARN.split('/')[1]);
    resource.setOperation(record.eventName);
    eventInterface.addToMetadata(trigger, {
        region: record.awsRegion,
        sequence_number: record.dynamodb.SequenceNumber,
        item_hash: itemHash,
        total_record_count: event.Records.length,
    }, {
        data: JSON.stringify(event.Records),
    });
}

/**
 * Initializes an event representing a trigger to the lambda caused by API Trigger
 * @param {object} event The event the lambda was triggered with
 * @param {proto.event_pb.Event} trigger An Event to initialize as the trigger
 */
function createElbTrigger(event, trigger) {
    const resource = trigger.getResource();
    trigger.setId(`elb-${uuid4()}`);
    resource.setName(event.headers.host);
    resource.setOperation(event.httpMethod);
    eventInterface.addToMetadata(trigger, {
        query_string_parameters: JSON.stringify(event.queryStringParameters),
        target_group_arn: event.requestContext.elb.targetGroupArn,
        path: event.path,
    }, {
        body: JSON.stringify(event.body),
        headers: JSON.stringify(event.headers),
    });
}


/**
 * Initializes an event representing a trigger to the lambda caused by Cognito
 * @param {object} event The event the lambda was triggered with
 * @param {proto.event_pb.Event} trigger An Event to initialize as the trigger
 */
function createCognitoTrigger(event, trigger) {
    const resource = trigger.getResource();
    trigger.setId(`cognito-${uuid4()}`);
    resource.setName(event.userPoolId);
    resource.setOperation(event.triggerSource);
    eventInterface.addToMetadata(trigger, {
        username: event.userName,
        region: event.region,
    }, {
        caller_context: event.callerContext,
        request: event.request,
        response: event.response,
    });
}

const resourceTypeToFactoryMap = {
    s3: createS3Trigger,
    json: createJSONTrigger,
    kinesis: createKinesisTrigger,
    events: createEventsTrigger,
    sns: createSNSTrigger,
    sqs: createSQSTrigger,
    api_gateway: createAPIGatewayTrigger,
    api_gateway_no_proxy: createNoProxyAPIGatewayTrigger,
    api_gateway_websocket: createWebSocketTrigger,
    api_gateway_http2: createAPIGatewayHTTPV2Trigger,
    dynamodb: createDynamoDBTrigger,
    elastic_load_balancer: createElbTrigger,
    cognito: createCognitoTrigger,
};


/**
 * Creates an {@link proto.event_pb.Event} describing the lambda trigger
 * @param {object} event The event the lambda was triggered with
 * @param {object} context The context the lambda was triggered with
 * @return {proto.event_pb.Event} The trigger of the lambda
 */
module.exports.createFromEvent = function createFromEvent(event, context) {
    let triggerService = 'json';
    if (event) {
        if ('Records' in event) {
            if ('EventSource' in event.Records[0]) {
                triggerService = event.Records[0].EventSource.split(':').pop();
            }

            if ('eventSource' in event.Records[0]) {
                triggerService = event.Records[0].eventSource.split(':').pop();
            }
        } else if ('source' in event && 'detail-type' in event && 'detail' in event) {
            triggerService = 'events';
        } else if ('source' in event && event.source) {
            triggerService = event.source.split('.').pop();
        } else if (('requestContext' in event) && ('elb' in event.requestContext)) {
            triggerService = 'elastic_load_balancer';
        } else if ('httpMethod' in event) {
            triggerService = 'api_gateway';
        } else if (('context' in event) && ('http-method' in event.context)) {
            triggerService = 'api_gateway_no_proxy';
        } else if ('dynamodb' in event) {
            triggerService = 'dynamodb';
        } else if ('userPoolId' in event) {
            triggerService = 'cognito';
        } else if (
            ('requestContext' in event) &&
            ('apiId' in event.requestContext) &&
            ('http' in event.requestContext)
        ) {
            triggerService = 'api_gateway_http2';
        } else if (('requestContext' in event) && ('apiId' in event.requestContext)) {
            triggerService = 'api_gateway_websocket';
        }
    }

    const resource = new serverlessEvent.Resource();
    const trigger = new serverlessEvent.Event();
    trigger.setResource(resource);
    resourceTypeToFactoryMap[triggerService](event, trigger, context);
    fillCommonFields(trigger, triggerService);
    return trigger;
};
