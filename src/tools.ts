import { AgentName, ToolSchema } from './types';

export const executeTool: ToolSchema = {
  type: 'function',
  function: {
    name: 'execute',
    description:
      'Write and run a Python script in the project directory. ' +
      'The only way to interact with the filesystem, install ' +
      'dependencies, and run commands.',
    parameters: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description:
            'Full text of the Python script. It will be saved in the working ' +
            'directory and executed.'
        },
        command: {
          type: 'string',
          description:
            'Command to run the script. If omitted, the default launch ' +
            'command is used.'
        }
      },
      required: ['script']
    }
  }
};

export const sendMessageTool: ToolSchema = {
  type: 'function',
  function: {
    name: 'send_message',
    description:
      'Send a text message to the other agent. ' +
      'Files are not attached — the recipient will read them via execute.',
    parameters: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          enum: ['executor', 'critic'],
          description: 'Recipient of the message.'
        },
        message: {
          type: 'string',
          description: 'Message text.'
        }
      },
      required: ['to', 'message']
    }
  }
};

export const finalizeTool: ToolSchema = {
  type: 'function',
  function: {
    name: 'finalize',
    description:
      'Finish the task. Available only to the CRITIC.',
    parameters: {
      type: 'object',
      properties: {
        comment: {
          type: 'string',
          description: 'Comment on task completion.'
        }
      },
      required: ['comment']
    }
  }
};

export function toolsFor(who: AgentName): ToolSchema[] {
  return who === 'critic'
    ? [executeTool, sendMessageTool, finalizeTool]
    : [executeTool, sendMessageTool];
}
